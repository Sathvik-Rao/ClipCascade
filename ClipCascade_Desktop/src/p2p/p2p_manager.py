import json
import logging
import time
import websocket
import asyncio
import uuid

from threading import Thread
from core.config import Config
from interfaces.ws_interface import WSInterface
from utils.cipher_manager import CipherManager
from clipboard.clipboard_manager import ClipboardManager
from utils.notification_manager import NotificationManager
from utils.request_manager import RequestManager
from core.constants import *
from aiortc import (
    RTCPeerConnection,
    RTCIceServer,
    RTCIceCandidate,
    RTCSessionDescription,
    RTCConfiguration,
    RTCDataChannel,
)


if PLATFORM.startswith(LINUX) and not XMODE:
    from cli.tray import TaskbarPanel
else:
    from gui.tray import TaskbarPanel

if PLATFORM == MACOS:
    import ssl
    import certifi


class P2PManager(WSInterface):
    def __init__(self, config: Config, is_login_phase=True):
        self.config = config
        self.clipboard_manager = ClipboardManager(self.config)
        self.cipher_manager = CipherManager(self.config)
        self.notification_manager = NotificationManager(self.config)
        self.sys_tray: TaskbarPanel = None
        self.first_conn_lost = True
        self.is_login_phase = is_login_phase
        self.ws_client = None
        self.is_connected = False
        self.disconnected = False
        self.is_auto_reconnecting = False
        self.is_clipboard_monitoring_on = False

        # Fragment variables
        self.sending_fragment_id = ""  # The id of the fragment currently being sent
        self.receiving_fragments: dict = (
            {}
        )  # Mapping: fragmentid:str -> fragment:list[str]
        self.sending_fragment_stats: str = None
        self.receiving_fragment_stats: str = None

        # p2p variables
        self.my_peer_id: str = None  # Own peer id assigned by the server
        self.peers: set[str] = set()  # All peers in this 'room'
        self.peer_connections: dict[str, RTCPeerConnection] = (
            {}
        )  # Mapping: peer_id -> RTCPeerConnection
        self.data_channels: dict[str, RTCDataChannel] = (
            {}
        )  # Mapping: peer_id -> DataChannel
        self.live_connections: int = 0  # Number of active connections

        # Event loop for asyncio
        self.loop = asyncio.new_event_loop()
        self.loop_thread = Thread(
            target=self.loop.run_forever, name="P2PManagerEventLoopThread", daemon=True
        )
        self.loop_thread.start()

    def schedule_task(self, coro):
        """Submit an async function to the manager's event loop thread."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def set_tray_ref(self, sys_tray: TaskbarPanel):
        """
        Sets the system tray reference.
        """
        self.sys_tray = sys_tray
        self.clipboard_manager.set_tray_ref(sys_tray)

    def get_stats(self) -> str:
        stats = "📊"
        stats += f" Peers: {self.live_connections}"
        if self.sending_fragment_stats is not None:
            stats += f" | Sending: {self.sending_fragment_stats}"
        if self.receiving_fragment_stats is not None:
            stats += f" | Receiving: {self.receiving_fragment_stats}"
        return stats

    def get_total_timeout(self):
        """
        Returns the total timeout value in milliseconds."""
        return (RECONNECT_WS_TIMER * 1000) + WEBSOCKET_TIMEOUT

    def connect(self) -> tuple[bool, str]:
        """
        Connects to the P2P websocket signaling server.
        """
        try:
            if self.ws_client is not None:
                return

            self.ws_client = websocket.WebSocketApp(
                url=self.config.data["websocket_url"],
                header={
                    "Cookie": RequestManager.format_cookie(self.config.data["cookie"])
                },
                on_open=self._on_ws_open,
                on_error=self._on_ws_error,
                on_message=self._on_ws_message,
                on_close=self._on_ws_close,
            )

            if PLATFORM == MACOS:
                ssl_context = ssl.create_default_context(cafile=certifi.where())
                Thread(
                    target=self.ws_client.run_forever,
                    kwargs={"sslopt": {"context": ssl_context}},
                    daemon=True,
                ).start()
            else:
                Thread(
                    target=self.ws_client.run_forever,
                    daemon=True,
                ).start()

            if not self.is_clipboard_monitoring_on:
                # Start clipboard monitoring
                self.is_clipboard_monitoring_on = True
                self.clipboard_manager.on_copy(self.send)

            if not self.is_login_phase:
                return True, ""

            total_ms = 0
            while self.is_connected is False:
                time.sleep(0.25)
                total_ms += 250
                if 0 < WEBSOCKET_TIMEOUT < total_ms:
                    self.ws_client.close()
                    raise TimeoutError(
                        f"Connection to {self.config.data['websocket_url']} timed out"
                    )

            return True, "Websocket connected"
        except Exception as e:
            msg = f"Failed to connect websocket: {e}"
            logging.error(msg)
            return False, msg

    def _on_ws_close(self, ws, *args):
        self.ws_client = None
        self.is_connected = False
        # Auto Reconnect
        if not self.is_login_phase and not self.disconnected:
            self.is_auto_reconnecting = True
            if self.first_conn_lost:
                self.notification_manager.notify(
                    title=f"{APP_NAME}: WebSocket Connection Lost ⛓️‍💥",
                    message="Check your internet connection. Retrying...",
                )
                self.first_conn_lost = False
            time.sleep(RECONNECT_WS_TIMER)  # seconds
            self.connect()

    def manual_reconnect(self):
        if not self.is_auto_reconnecting:
            self.disconnected = False
            self.connect()

    def _on_ws_message(self, ws, message):
        self.schedule_task(self._on_ws_message_async(message))

    async def _on_ws_message_async(self, message):
        try:
            logging.debug("\n<<< " + str(message))
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "ASSIGNED_ID":
                if self.my_peer_id is not None and self.my_peer_id != data["peerId"]:
                    await self._cleanup_peer_connections()
                self.my_peer_id = data["peerId"]
            elif msg_type == "PEER_LIST":
                await self._handle_peer_list(data["peers"])
            elif msg_type == "OFFER":
                await self._handle_offer(data["fromPeerId"], data["offer"])

            elif msg_type == "ANSWER":
                await self._handle_answer(data["fromPeerId"], data["answer"])

            elif msg_type == "ICE_CANDIDATE":
                await self._handle_ice_candidate(data["fromPeerId"], data["candidate"])

        except Exception as e:
            logging.error(f"Failed to handle websocket message: {e}")

    def _on_ws_open(self, ws, *args):
        try:
            if self.disconnected:
                self.disconnect()
                return

            # logging.info("Websocket connected")
            self.is_connected = True
            self.is_auto_reconnecting = False
            if not self.first_conn_lost:
                self.first_conn_lost = True
                self.notification_manager.notify(
                    title=f"{APP_NAME}: WebSocket Connection Restored 🔗",
                    message="Connection re-established",
                )
        except Exception as e:
            logging.error(f"Failed to connect websocket: {e}")

    def _on_ws_error(self, ws, error, *args):
        logging.debug(error)

    def ws_send(self, data: dict):
        try:
            if self.ws_client is None or not self.is_connected:
                return

            message = json.dumps(data)
            logging.debug("\n>>> " + message)
            self.ws_client.send(message)
        except Exception as e:
            logging.error(f"Failed to send websocket message: {e}")

    def ws_close(self):
        if self.ws_client is not None:
            self.ws_client.close()
            self.ws_client = None

    def disconnect(self):
        self.schedule_task(self._disconnect())

    async def _disconnect(self):
        """
        Stops the clipboard manager, closes the WebSocket,
        closes all data channels, clears all peer-related data,
        and resets P2P tracking variables.
        """
        try:
            self.clipboard_manager.previous_clipboard_hash = 0
            self.disconnected = True
            self.first_conn_lost = True

            # Close the websocket
            try:
                self.ws_close()
                self.is_connected = False
                logging.info("Websocket disconnected")
            except Exception as e:
                pass  # silent catch

            # Cleanup peer connections
            await self._cleanup_peer_connections()

            # Stop the clipboard manager
            self.clipboard_manager.stop()
            self.is_clipboard_monitoring_on = False
        except Exception as e:
            logging.error(f"Failed to disconnect websocket: {e}")

    async def _cleanup_peer_connections(self):
        # Close data channels
        for dc in self.data_channels.values():
            try:
                dc.close()
            except Exception:
                pass

        # Close peer connections
        for pc in self.peer_connections.values():
            try:
                await pc.close()
            except Exception:
                pass

        # Clear all P2P-related variables
        self.my_peer_id = None
        self.peers.clear()
        self.peer_connections.clear()
        self.data_channels.clear()
        self.live_connections = 0

    async def _handle_peer_list(self, peer_list):
        """
        The server has told us about the entire set of peer IDs in this 'room'.
        We create connections or data channels accordingly.
        """
        updated_peers = set(peer_list)
        # 1) Remove any stale peers
        await self._remove_stale_peers(updated_peers)

        # 2) Update self.peers
        self.peers = updated_peers

        # 3) For each peer, if we have no RTCPeerConnection, create one
        for pid in self.peers:
            if pid == self.my_peer_id:
                continue  # Ignore self

            if pid not in self.peer_connections:
                pc = self._create_peer_connection(pid)
                self.peer_connections[pid] = pc

                # TIE-BREAKER logic:
                # We only createOffer if we are the "lesser" peer ID (i.e. myPeerId < pid).
                # This helps avoid collisions where both sides create an offer simultaneously.
                if self.my_peer_id < pid:
                    # We are the "offerer"
                    channel = pc.createDataChannel("cliptext")
                    self.data_channels[pid] = channel
                    self._setup_data_channel(pid, channel)
                    await self._create_offer(pid)

    async def _remove_stale_peers(self, updated_peers):
        """
        Close connections and data channels for peers that no longer exist in updated_peers.
        """
        # Find which peers are no longer present
        stale_ids = set(self.peer_connections.keys()) - updated_peers
        for old_pid in stale_ids:
            logging.debug(f"Removing stale peer: {old_pid}")
            # Close data channel
            dc = self.data_channels.pop(old_pid, None)
            if dc is not None:
                try:
                    dc.close()
                except Exception:
                    pass

            # Close RTCPeerConnection
            pc = self.peer_connections.pop(old_pid, None)
            if pc is not None:
                try:
                    await pc.close()
                except Exception:
                    pass

    def _create_peer_connection(self, remote_peer_id: str) -> RTCPeerConnection:
        """
        Create and return a new RTCPeerConnection, wired up with ICE-candidate and data-channel handling.
        """
        pc = RTCPeerConnection(
            configuration=RTCConfiguration(
                iceServers=[RTCIceServer(urls=[self.config.data["stun_url"]])]
            )
        )

        @pc.on("icecandidate")
        def on_icecandidate(candidate: RTCIceCandidate):
            # This fires when the local side gathers an ICE candidate
            if candidate is not None:
                candidate_line = P2PManager.dict_to_ice_candidate_line(
                    {
                        "component": candidate.component,
                        "foundation": candidate.foundation,
                        "ip": candidate.ip,
                        "port": candidate.port,
                        "priority": candidate.priority,
                        "protocol": candidate.protocol,
                        "type": candidate.type,
                        "raddr": candidate.relatedAddress,
                        "rport": candidate.relatedPort,
                        "tcptype": candidate.tcpType,
                    }
                )
                self.ws_send(
                    {
                        "type": "ICE_CANDIDATE",
                        "fromPeerId": self.my_peer_id,
                        "toPeerId": remote_peer_id,
                        "candidate": {
                            "candidate": candidate_line,
                            "sdpMid": candidate.sdpMid,
                            "sdpMLineIndex": candidate.sdpMLineIndex,
                        },
                    }
                )

        @pc.on("datachannel")
        def on_datachannel(channel):
            # This fires when the remote side creates a datachannel
            self.data_channels[remote_peer_id] = channel
            self._setup_data_channel(remote_peer_id, channel)

        return pc

    async def _create_offer(self, remote_peer_id: str):
        """
        Create an SDP offer for the specified remote peer and send it out via signaling.
        """
        pc = self.peer_connections[remote_peer_id]
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        self.ws_send(
            {
                "type": "OFFER",
                "fromPeerId": self.my_peer_id,
                "toPeerId": remote_peer_id,
                "offer": {
                    "type": pc.localDescription.type,
                    "sdp": pc.localDescription.sdp,
                },
            }
        )

    async def _handle_offer(self, from_peer_id: str, offer: dict):
        """
        Respond to an incoming OFFER from a remote peer.
        """
        pc = self.peer_connections.get(from_peer_id)
        if not pc:
            pc = self._create_peer_connection(from_peer_id)
            self.peer_connections[from_peer_id] = pc

        desc = RTCSessionDescription(sdp=offer["sdp"], type=offer["type"])
        await pc.setRemoteDescription(desc)

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        self.ws_send(
            {
                "type": "ANSWER",
                "fromPeerId": self.my_peer_id,
                "toPeerId": from_peer_id,
                "answer": {
                    "type": pc.localDescription.type,
                    "sdp": pc.localDescription.sdp,
                },
            }
        )

    async def _handle_answer(self, from_peer_id: str, answer: dict):
        """
        Handle an incoming ANSWER to our previously sent OFFER.
        """
        pc = self.peer_connections.get(from_peer_id)
        if not pc:
            logging.warning(
                f"No peer connection exists for id={from_peer_id}, ignoring ANSWER."
            )
            return
        desc = RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
        await pc.setRemoteDescription(desc)

    async def _handle_ice_candidate(self, from_peer_id: str, candidate_data: dict):
        """
        Handle an incoming ICE candidate from the remote peer.
        """
        pc = self.peer_connections.get(from_peer_id)
        if not pc:
            logging.warning(
                f"No peer connection exists for id={from_peer_id}, ignoring ICE_CANDIDATE."
            )
            return

        parsed_candidate = P2PManager.parse_ice_candidate_line(
            candidate_data.get("candidate")
        )
        ice_candidate = RTCIceCandidate(
            component=parsed_candidate.get("component"),
            foundation=parsed_candidate.get("foundation"),
            ip=parsed_candidate.get("ip"),
            port=parsed_candidate.get("port"),
            priority=parsed_candidate.get("priority"),
            protocol=parsed_candidate.get("protocol"),
            type=parsed_candidate.get("type"),
            relatedAddress=parsed_candidate.get("raddr"),
            relatedPort=parsed_candidate.get("rport"),
            sdpMid=candidate_data.get("sdpMid"),
            sdpMLineIndex=candidate_data.get("sdpMLineIndex"),
            tcpType=parsed_candidate.get("tcptype"),
        )
        await pc.addIceCandidate(ice_candidate)

    def _setup_data_channel(self, remote_peer_id: str, channel: RTCDataChannel):
        """
        Set up handlers for an RTCDataChannel (open, message, close, error).
        """

        @channel.on("open")
        def on_open():
            self.live_connections += 1

        # manually call on_open if the channel is already open by the time event is attached
        if channel.readyState == "open":
            on_open()

        @channel.on("message")
        def on_message(message):
            self._receive(message)

        @channel.on("close")
        def on_close():
            self.live_connections -= 1

        @channel.on("error")
        def on_error(e):
            logging.error(f"[data] Data channel error with {remote_peer_id}: {e}")

    def send(self, payload: str, payload_type: str = "text"):
        self.schedule_task(self._send(payload, payload_type))

    def reset_sending_fragment_id(self):
        self.sending_fragment_id = ""
        self.sending_fragment_stats = None

    async def _send(self, payload: str, payload_type: str = "text"):
        try:
            if self.clipboard_manager.has_clipboard_changed(payload):
                self.reset_sending_fragment_id()
                self.reset_receiving_fragments()

                raw_payload_size_in_bytes = len(payload.encode("utf-8"))

                if self.config.data["cipher_enabled"]:
                    payload = CipherManager.encode_to_json_string(
                        **self.cipher_manager.encrypt(payload)
                    )

                fragments = P2PManager.fragment_string(payload)
                metadata = {
                    "id": str(uuid.uuid4()),
                    "isFragmented": len(fragments) > 1,
                    "index": 0,
                    "totalFragments": len(fragments),
                    "combinedRawPayloadSizeInBytes": raw_payload_size_in_bytes,
                }

                self.sending_fragment_id = metadata["id"]
                for fragment in fragments:
                    if self.sending_fragment_id != metadata["id"]:
                        break

                    body = json.dumps(
                        {
                            "payload": fragment,
                            "type": payload_type,
                            "metadata": metadata,
                        }
                    )
                    metadata["index"] += 1

                    # Send to all open DataChannels
                    for peer_id, channel in self.data_channels.items():
                        if channel.readyState == "open":
                            channel.send(body)

                    if metadata["isFragmented"]:
                        self.sending_fragment_stats = (
                            f"{metadata['index']}/{metadata['totalFragments']}"
                        )
                else:
                    self.reset_sending_fragment_id()

        except Exception as e:
            logging.error(f"Failed to send data: {e}")

    def reset_receiving_fragments(self):
        self.receiving_fragments = {}
        self.receiving_fragment_stats = None

    def _receive(self, frame: any) -> str:
        try:
            self.reset_sending_fragment_id()
            body = json.loads(frame)
            payload = body["payload"]
            payload_type = body.get("type", "text")
            metadata = body.get("metadata")

            # Check if the payload exceeds the maximum size: first layer protection
            if (
                metadata is not None
                and self.config.data["max_clipboard_size_local_limit_bytes"] is not None
                and metadata["combinedRawPayloadSizeInBytes"]
                > self.config.data["max_clipboard_size_local_limit_bytes"]
            ):
                self.reset_receiving_fragments()
                logging.debug(
                    f"Payload size limit exceeded: {metadata['combinedRawPayloadSizeInBytes']} bytes exceeds {self.config.data['max_clipboard_size_local_limit_bytes']} bytes"
                )
                return

            # Fragmented message handling
            if metadata is not None and metadata["isFragmented"]:
                self.receiving_fragment_stats = (
                    f"{metadata['index'] + 1}/{metadata['totalFragments']}"
                )
                if metadata["id"] in self.receiving_fragments:
                    self.receiving_fragments[metadata["id"]][
                        metadata["index"]
                    ] = payload
                    if metadata["index"] == metadata["totalFragments"] - 1:
                        if all(
                            s != "" for s in self.receiving_fragments[metadata["id"]]
                        ):
                            payload = "".join(self.receiving_fragments[metadata["id"]])
                        else:
                            self.reset_receiving_fragments()
                            logging.error(
                                "Failed to receive: One or more fragments are missing or clipboard has changed."
                            )
                            return
                    else:
                        return
                else:
                    self.reset_receiving_fragments()
                    self.receiving_fragments[metadata["id"]] = [""] * metadata[
                        "totalFragments"
                    ]
                    self.receiving_fragments[metadata["id"]][
                        metadata["index"]
                    ] = payload
                    return

            if self.config.data["cipher_enabled"]:
                payload = self.cipher_manager.decrypt(
                    **CipherManager.decode_from_json_string(payload)
                )

            if self.clipboard_manager.has_clipboard_changed(payload):
                self.reset_receiving_fragments()
                self.clipboard_manager.base64_to_clipboard(
                    base64_string=payload, type_=payload_type
                )
        except json.decoder.JSONDecodeError:
            logging.error(
                "If cipher is enabled, please make sure it is enabled on all devices"
            )
        except Exception as e:
            logging.error(f"Failed to receive data: {e}")

    @staticmethod
    def fragment_string(s: str, fragment_size: int = FRAGMENT_SIZE) -> list[str]:
        """
        Splits a string into a list of fragments, each with a maximum size of `fragment_size` bytes.

        Args:
            s (str): The string to fragment.
            fragment_size (int): The maximum size of each fragment in bytes.

        Returns:
            list[str]: A list of string fragments.
        """
        # Encode the string to bytes to accurately split by byte size
        s_bytes = s.encode("utf-8")
        fragments = [
            s_bytes[i : i + fragment_size].decode("utf-8", errors="ignore")
            for i in range(0, len(s_bytes), fragment_size)
        ]
        return fragments

    @staticmethod
    def parse_ice_candidate_line(candidate_line: str) -> dict:
        """
        Parse a full ICE candidate line into its constituent fields.

        Returns a dict with keys:
            foundation, component, protocol, priority,
            ip, port, type,
            raddr, rport, tcptype, generation, ufrag, network-id, network-cost,
            plus any other unrecognized "key value" pairs.

        Example ICE candidate line:
            "candidate:3365442476 1 udp 2113939711 4c76248e-9690-49db-9043-6cd01cc3a9b4.local 59478 typ host generation 0 ufrag HoZP network-cost 999"
        """
        candidate_line = candidate_line.strip()
        tokens = candidate_line.split()

        # 1) Must start with something like "candidate:..."
        if not tokens or not tokens[0].startswith("candidate:"):
            raise ValueError(
                "Not a valid ICE candidate line (must start with 'candidate:')."
            )

        # 2) Basic mandatory fields (RFC 5245)
        #
        #    candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <candType>
        #    e.g.:
        #    "candidate:3365442476 1 udp 2113939711 192.168.1.10 5000 typ host ..."
        foundation = tokens[0].split(":", 1)[1]
        component = int(tokens[1])
        protocol = tokens[2].lower()
        priority = int(tokens[3])
        ip = tokens[4]
        port = int(tokens[5])

        # Next token should be "typ"
        if tokens[6] != "typ":
            raise ValueError(
                f"Expected 'typ' after port but found '{tokens[6]}' in ICE candidate line."
            )

        candidate_type = tokens[7]

        # 3) Optional fields come after index 8, usually as "key value" pairs
        #    e.g. "raddr 1.2.3.4 rport 1234 tcptype active generation 0 ufrag ABCD network-cost 999"
        extras = {}
        idx = 8
        while idx < len(tokens):
            key = tokens[idx]
            # If there's no "value" after this key, store None and break.
            if idx + 1 >= len(tokens):
                extras[key] = None
                break
            value = tokens[idx + 1]

            # Store it
            extras[key] = value
            idx += 2

        # 4) Pull out commonly known keys if they exist in extras
        raddr = extras.pop("raddr", None)
        rport = extras.pop("rport", None)
        tcptype = extras.pop("tcptype", None)
        generation = extras.pop("generation", None)
        ufrag = extras.pop("ufrag", None)
        network_id = extras.pop("network-id", None)
        network_cost = extras.pop("network-cost", None)

        # 5) Build final dictionary
        candidate_dict = {
            "foundation": foundation,
            "component": component,
            "protocol": protocol,
            "priority": priority,
            "ip": ip,
            "port": port,
            "type": candidate_type,
            "raddr": raddr,
            "rport": rport,
            "tcptype": tcptype,
            "generation": generation,
            "ufrag": ufrag,
            "network-id": network_id,
            "network-cost": network_cost,
            # Put anything else we didn't explicitly handle into 'extras'
            "extras": extras,
        }

        return candidate_dict

    @staticmethod
    def dict_to_ice_candidate_line(candidate_dict: dict) -> str:
        """
        Convert a dictionary of ICE candidate fields back into the ICE candidate line string.

        Expects a dict with at least the following keys:
            - foundation (str)
            - component (int)
            - protocol (str)
            - priority (int)
            - ip (str)
            - port (int)
            - type (str)

        The known optional keys are:
            - raddr, rport, tcptype, generation, ufrag
            - network-id, network-cost
        These will be appended as "key value" pairs if they exist (and are not None).

        Additionally, any leftover entries in candidate_dict["extras"] are appended at the end.

        Returns a line starting with "candidate:..."
        """
        foundation = candidate_dict["foundation"]
        component = candidate_dict["component"]
        protocol = candidate_dict["protocol"]
        priority = candidate_dict["priority"]
        ip = candidate_dict["ip"]
        port = candidate_dict["port"]
        candidate_type = candidate_dict["type"]

        line_parts = [
            f"candidate:{foundation}",
            str(component),
            protocol.lower(),
            str(priority),
            ip,
            str(port),
            "typ",
            candidate_type,
        ]

        # Append known optional fields if present.
        # (Only add if the value is not None)
        if candidate_dict.get("raddr") is not None:
            line_parts += ["raddr", str(candidate_dict["raddr"])]

        if candidate_dict.get("rport") is not None:
            line_parts += ["rport", str(candidate_dict["rport"])]

        if candidate_dict.get("tcptype") is not None:
            line_parts += ["tcptype", str(candidate_dict["tcptype"])]

        if candidate_dict.get("generation") is not None:
            line_parts += ["generation", str(candidate_dict["generation"])]

        if candidate_dict.get("ufrag") is not None:
            line_parts += ["ufrag", str(candidate_dict["ufrag"])]

        if candidate_dict.get("network-id") is not None:
            line_parts += ["network-id", str(candidate_dict["network-id"])]

        if candidate_dict.get("network-cost") is not None:
            line_parts += ["network-cost", str(candidate_dict["network-cost"])]

        # Finally, any 'extras' are appended at the end
        extras = candidate_dict.get("extras", {})
        for k, v in extras.items():
            line_parts.append(str(k))
            if v is not None:
                line_parts.append(str(v))

        return " ".join(line_parts)
