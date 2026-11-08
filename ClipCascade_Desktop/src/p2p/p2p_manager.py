import json
import logging
import time
import websocket
import asyncio
import uuid
from collections import OrderedDict

from threading import Lock, Thread
from typing import Dict, List, Optional
from core.config import Config
from interfaces.ws_interface import WSInterface
from utils import binary_protocol as binary
from utils.reconnect import ReconnectMixin
from utils.transfer_flow import send_shared_fragments, TransferSuperseded
from utils.transfer_limits import (SIZE_FIELD, valid_size, receive_limit, capability_message,
                                  read_capability, allows_content, metadata_size, content_size)
from utils.cipher_manager import CipherManager
from clipboard.clipboard_manager import ClipboardManager
from utils.notification_manager import NotificationManager
from utils.request_manager import RequestManager
from utils.ssl_helper import websocket_sslopt_for_config
from utils.aioice_compat import install_stun_retry_guard
from core.constants import *
from aiortc import (
    RTCPeerConnection,
    RTCIceServer,
    RTCIceCandidate,
    RTCSessionDescription,
    RTCConfiguration,
    RTCDataChannel,
)

if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
    from cli.tray import TaskbarPanel
else:
    from gui.tray import TaskbarPanel

class P2PManager(ReconnectMixin, WSInterface):
    def __init__(self, config: Config, is_login_phase=True):
        install_stun_retry_guard()
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
        self._init_reconnect()
        self._disconnect_future = None

        # Fragment variables
        self._send_generation = 0
        self._preparation_lock = asyncio.Lock()
        self._discarded_fragments = OrderedDict()
        self._peer_receive_limits = {}
        self.sending_fragment_id = ""  # The id of the fragment currently being sent
        # Mapping: fragment_id:str -> {"last_received_at": float, "fragments": list[str]}
        # Refresh the timestamp on each fragment so a dropped final
        # fragment doesn't leak memory forever.
        self.receiving_fragments: dict = {}
        self.sending_fragment_stats: str = None
        self.receiving_fragment_stats: str = None

        # p2p variables
        self.my_peer_id: str = None  # Own peer id assigned by the server
        self.peers: set[str] = set()  # All peers in this 'room'
        self.peer_connections: dict[str, RTCPeerConnection] = (
            {}
        )  # Mapping: peer_id -> RTCPeerConnection
        self.data_channels: dict[str, RTCDataChannel] = {}  # Mapping: peer_id -> DataChannel
        self.live_connections: int = 0  # Number of open data channels (derived; see _sync)
        self._live_connections_lock = Lock()
        # If PEER_LIST arrives before ASSIGNED_ID (e.g. right after signaling reconnect), mesh setup waits.
        self._pending_peer_list: Optional[List[str]] = None

        # True during full P2P teardown (logout / signaling reconnect prep); suppresses ICE recovery.
        self._p2p_shutting_down: bool = False
        # Serialize recover + offer handling per peer (same asyncio loop as signaling handlers).
        self._peer_recovery_locks: Dict[str, asyncio.Lock] = {}
        self._peer_retry_attempts: dict[str, int] = {}
        self._peer_connection_deadlines: dict[str, asyncio.TimerHandle] = {}
        self._pending_ice: dict[str, list] = {}
        self._dc_heartbeat_handle: Optional[asyncio.TimerHandle] = None

        # Event loop for asyncio
        self.loop = asyncio.new_event_loop()
        self.loop_thread = Thread(
            target=self.loop.run_forever, name="P2PManagerEventLoopThread", daemon=True
        )
        self.loop_thread.start()

    def schedule_task(self, coro):
        """Submit an async function to the manager's event loop thread."""
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def _cancel_dc_heartbeat(self) -> None:
        if self._dc_heartbeat_handle is not None:
            self._dc_heartbeat_handle.cancel()
            self._dc_heartbeat_handle = None

    def _dc_heartbeat_tick(self) -> None:
        self._dc_heartbeat_handle = None
        if self.disconnected or self._p2p_shutting_down or not self.is_connected:
            return
        self._prune_stale_receiving_fragments()
        ping = capability_message(self.config)
        for ch in list(self.data_channels.values()):
            try:
                if getattr(ch, "readyState", "") == "open":
                    ch.send(ping)
            except Exception:
                pass
        self._schedule_next_dc_heartbeat()

    def _schedule_next_dc_heartbeat(self) -> None:
        if self.disconnected or self._p2p_shutting_down or not self.is_connected:
            return
        self._cancel_dc_heartbeat()
        self._dc_heartbeat_handle = self.loop.call_later(
            P2P_DC_HEARTBEAT_INTERVAL_SEC, self._dc_heartbeat_tick
        )

    def _restart_dc_heartbeat(self) -> None:
        self._cancel_dc_heartbeat()
        if not self.disconnected and not self._p2p_shutting_down and self.is_connected:
            self._schedule_next_dc_heartbeat()

    def set_tray_ref(self, sys_tray: TaskbarPanel):
        """
        Sets the system tray reference.
        """
        self.sys_tray = sys_tray
        self.clipboard_manager.set_tray_ref(sys_tray)

    def _sync_live_connections_count(self):
        """Set live_connections from open data channels (avoids +/- drift and negatives)."""
        with self._live_connections_lock:
            self.live_connections = sum(
                1 for ch in list(self.data_channels.values()) if getattr(ch, "readyState", "") == "open"
            )

    def get_stats(self) -> str:
        self._sync_live_connections_count()
        with self._live_connections_lock:
            n = self.live_connections
        if not self.is_connected and (self.disconnected or n == 0):
            return "Disconnected" if self.disconnected else "Reconnecting…"
        stats = f"📊 Peers: {n}"
        if not self.is_connected:
            stats += " | Signaling: Reconnecting…"
        loading = self.clipboard_manager.get_loading_status()
        if loading:
            stats += f" | {loading}"
        if self.sending_fragment_stats is not None:
            stats += f" | Sending: {self.sending_fragment_stats}"
        if self.receiving_fragment_stats is not None:
            stats += f" | Receiving: {self.receiving_fragment_stats}"
        return stats

    def get_total_timeout(self):
        """
        Returns the total timeout value in milliseconds."""
        return (RECONNECT_WS_TIMER * 1000) + WEBSOCKET_TIMEOUT

    def _connect_once(self) -> tuple[bool, str]:
        """
        Connects to the P2P websocket signaling server.
        """
        try:
            if self._disconnect_future is not None:
                self._disconnect_future.result(timeout=90)
                self._disconnect_future = None
            if self.ws_client is not None:
                if self.is_connected:
                    return True, ""
                self.ws_close()

            # Cleanup must finish before starting the socket: doing this in
            # on_open can consume the entire WebSocket handshake timeout.
            self.schedule_task(self._prepare_reconnect_bootstrap()).result(timeout=90)
            if self.disconnected:
                return False, "Websocket disconnected"
            self.ws_client = websocket.WebSocketApp(
                url=self.config.data["websocket_url"],
                header={"Cookie": RequestManager.format_cookie(self.config.data["cookie"])},
                on_open=self._on_ws_open,
                on_error=self._on_ws_error,
                on_message=self._on_ws_message,
                on_close=self._on_ws_close,
            )

            ws_run_kw = {
                "ping_interval": P2P_WS_PING_INTERVAL_SEC,
                "ping_timeout": P2P_WS_PING_TIMEOUT_SEC,
            }
            ws_sslopt = websocket_sslopt_for_config(self.config)
            if ws_sslopt:
                ws_run_kw["sslopt"] = ws_sslopt
            Thread(
                target=self.ws_client.run_forever,
                kwargs=ws_run_kw,
                daemon=True,
            ).start()

            if not self.is_clipboard_monitoring_on:
                # Start clipboard monitoring
                self.is_clipboard_monitoring_on = True
                self.clipboard_manager.on_copy(self.send, self._on_local_change, self.can_send_content)

            total_ms = 0
            while self.is_connected is False:
                if self.disconnected:
                    self.ws_close()
                    return False, "Websocket disconnected"
                time.sleep(0.25)
                total_ms += 250
                if 0 < WEBSOCKET_TIMEOUT < total_ms:
                    self.ws_close()
                    raise TimeoutError(
                        f"Connection to {self.config.data['websocket_url']} timed out"
                    )

            return True, "Websocket connected"
        except Exception as e:
            self.is_connected = False
            msg = f"Failed to connect websocket: {e}"
            logging.error(msg)
            try:
                self.ws_close()
            except Exception:
                pass
            return False, msg

    def _on_ws_close(self, ws, *args):
        if ws is not self.ws_client:
            return
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
            self._start_reconnect()

    def _on_ws_message(self, ws, message):
        if ws is not self.ws_client:
            return
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
                if self._pending_peer_list is not None:
                    pending = self._pending_peer_list
                    self._pending_peer_list = None
                    await self._handle_peer_list(pending)
            elif msg_type == "PEER_LIST":
                await self._handle_peer_list(data["peers"])
            elif msg_type == "OFFER":
                await self._handle_offer(data["fromPeerId"], data["offer"])

            elif msg_type == "ANSWER":
                await self._handle_answer(data["fromPeerId"], data["answer"])

            elif msg_type == "ICE_CANDIDATE":
                await self._handle_ice_candidate(data["fromPeerId"], data["candidate"])

        except Exception:
            logging.exception("Failed to handle websocket message")

    async def _prepare_reconnect_bootstrap(self):
        """
        Runs on the asyncio signaling loop thread.
        Resets bootstrap state and tears down old mesh without clobbering newer
        ASSIGNED_ID / PEER_LIST values that may arrive during cleanup.
        """
        self.my_peer_id = None
        self._pending_peer_list = None
        await self._cleanup_peer_connections(clear_bootstrap_state=False)

    def _on_ws_open(self, ws, *args):
        if ws is not self.ws_client:
            return
        try:
            if self.disconnected:
                self.disconnect()
                return

            if ws is not self.ws_client or self.disconnected:
                return
            self.is_connected = True
            self.is_auto_reconnecting = False
            self._reconnect_attempts = 0
            self.loop.call_soon_threadsafe(self._restart_dc_heartbeat)
            if not self.first_conn_lost:
                self.first_conn_lost = True
                self.notification_manager.notify(
                    title=f"{APP_NAME}: WebSocket Connection Restored 🔗",
                    message="Connection re-established",
                )
        except Exception as e:
            logging.error(f"Failed to open P2P signaling session: {e}")

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
            ws = self.ws_client
            self.ws_client = None
            ws.close()

    def disconnect(self):
        self._stop_reconnect()
        self.is_connected = False
        self._disconnect_future = self.schedule_task(self._disconnect())

    def shutdown(self, timeout=5):
        """Finish pending disconnect work and stop the loop at application exit.

        Called from the shutdown worker, never from AppKit or the asyncio loop.
        Ordinary tray Disconnect keeps the loop alive for reconnection.
        """
        self._stop_reconnect()
        deadline = time.monotonic() + timeout
        try:
            if self._disconnect_future is not None:
                self._disconnect_future.result(timeout=timeout * 0.8)
        finally:
            try:
                # Signaling/ICE tasks can still be alive after peers close.
                # Cancel them on their own loop before releasing the loop.
                self.schedule_task(self._cancel_shutdown_tasks()).result(
                    timeout=max(0, deadline - time.monotonic())
                )
            finally:
                self.loop.call_soon_threadsafe(self.loop.stop)
                self.loop_thread.join(timeout=max(0, deadline - time.monotonic()))
                if not self.loop_thread.is_alive():
                    self.loop.close()

    async def _cancel_shutdown_tasks(self):
        tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _disconnect(self):
        """
        Stops the clipboard manager, closes the WebSocket,
        closes all data channels, clears all peer-related data,
        and resets P2P tracking variables.
        """
        try:
            self.clipboard_manager.previous_clipboard_hash = 0
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

    async def _cleanup_peer_connections(self, clear_bootstrap_state: bool = True):
        self._p2p_shutting_down = True
        for peer_id in list(self._peer_connection_deadlines):
            self._cancel_peer_connection_deadline(peer_id)
        self._cancel_dc_heartbeat()
        self.reset_sending_fragment_id()
        self.clipboard_manager.cancel_preparation()
        self.reset_receiving_fragments()
        self._peer_receive_limits.clear()
        try:
            try:
                for dc in list(self.data_channels.values()):
                    try:
                        dc.close()
                    except Exception:
                        pass

                for pc in list(self.peer_connections.values()):
                    try:
                        await asyncio.wait_for(self._close_peer_connection(pc), timeout=P2P_PC_CLOSE_TIMEOUT_SEC)
                    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                        pass
            finally:
                if clear_bootstrap_state:
                    self.my_peer_id = None
                self.peers.clear()
                self.peer_connections.clear()
                self.data_channels.clear()
                if clear_bootstrap_state:
                    self._pending_peer_list = None
                self._peer_recovery_locks.clear()
                self._peer_retry_attempts.clear()
                self._pending_ice.clear()
                with self._live_connections_lock:
                    self.live_connections = 0
        finally:
            self._p2p_shutting_down = False

    async def _handle_peer_list(self, peer_list):
        """
        The server has told us about the entire set of peer IDs in this 'room'.
        We create connections or data channels accordingly.
        """
        updated_peers = set(peer_list)
        # Keep room membership in sync before closing stale PCs so ICE recovery does not
        # treat removed peers as still present when data-channel close handlers run.
        self.peers = updated_peers
        await self._remove_stale_peers(updated_peers)

        if self.my_peer_id is None:
            self._pending_peer_list = list(peer_list)
            return

        # 3) For each peer, if we have no RTCPeerConnection, create one
        for pid in list(self.peers):
            if pid == self.my_peer_id:
                continue  # Ignore self

            async with self._get_peer_lock(pid):
                if self._p2p_shutting_down or pid not in self.peers or self.my_peer_id is None:
                    continue
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
            self._cancel_peer_connection_deadline(old_pid)
            logging.debug(f"Removing stale peer: {old_pid}")
            self._peer_recovery_locks.pop(old_pid, None)
            self._peer_retry_attempts.pop(old_pid, None)
            self._pending_ice.pop(old_pid, None)
            # Close data channel
            self._drop_peer_fragments(old_pid)
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
                    await asyncio.wait_for(self._close_peer_connection(pc), timeout=P2P_PC_CLOSE_TIMEOUT_SEC)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    pass

        self._sync_live_connections_count()

    def _get_peer_lock(self, peer_id: str) -> asyncio.Lock:
        lock = self._peer_recovery_locks.get(peer_id)
        if lock is None:
            lock = asyncio.Lock()
            self._peer_recovery_locks[peer_id] = lock
        return lock

    async def _close_peer_connection(self, pc) -> None:
        # aioice 0.9 (used by aiortc 1.10) cancels ICE checks without
        # awaiting them. Drain them before closing UDP sockets so their STUN
        # retry timers cannot run against a disposed transport. This private
        # compatibility access is optional for other aiortc versions.
        sctp = getattr(pc, "sctp", None)
        dtls = getattr(sctp, "transport", None)
        ice = getattr(dtls, "transport", None)
        connection = getattr(ice, "_connection", None)
        tasks = [
            check.task for check in getattr(connection, "_check_list", [])
            if check.task is not None and not check.task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await pc.close()

    async def _dispose_peer_connection(self, peer_id: str) -> None:
        """Close and drop one peer's DC/PC without changing self.peers (used by recovery and offer handling)."""
        self._cancel_peer_connection_deadline(peer_id)
        self._pending_ice.pop(peer_id, None)
        # Invalidate both objects before close callbacks can request recovery.
        pc = self.peer_connections.pop(peer_id, None)
        self._drop_peer_fragments(peer_id)
        dc = self.data_channels.pop(peer_id, None)
        if dc is not None:
            try:
                dc.close()
            except Exception:
                pass
        if pc is not None:
            try:
                await asyncio.wait_for(self._close_peer_connection(pc), timeout=P2P_PC_CLOSE_TIMEOUT_SEC)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
        self._sync_live_connections_count()

    async def _recover_peer_transport(
        self, remote_peer_id: str, dead_pc: Optional[RTCPeerConnection] = None
    ) -> None:
        """
        Re-establish WebRTC to a peer that is still in the room after ICE failure or data-channel loss.
        Signaling WebSocket stays up; no server change required.
        """
        if self._p2p_shutting_down or self.disconnected or self.is_login_phase:
            return
        if self.my_peer_id is None or remote_peer_id not in self.peers:
            return
        if dead_pc is None:
            dead_pc = self.peer_connections.get(remote_peer_id)
        if dead_pc is None or self.peer_connections.get(remote_peer_id) is not dead_pc:
            return

        # Keep failed networks from producing a tight reconnect loop. Sleeping
        # outside the peer lock lets a remote offer repair the connection first.
        attempt = self._peer_retry_attempts.get(remote_peer_id, 0)
        await asyncio.sleep(min(2 ** min(attempt, 5), 30))

        lock = self._get_peer_lock(remote_peer_id)
        async with lock:
            if self._p2p_shutting_down or self.disconnected or self.my_peer_id is None:
                return
            if remote_peer_id not in self.peers:
                return
            if dead_pc is not None and self.peer_connections.get(remote_peer_id) is not dead_pc:
                return
            ch = self.data_channels.get(remote_peer_id)
            # A failed transport can leave its channel reporting open. Only
            # suppress a queued retry when the transport has actually recovered.
            if (
                ch is not None
                and getattr(ch, "readyState", "") == "open"
                and dead_pc.connectionState == "connected"
                and dead_pc.iceConnectionState in ("connected", "completed")
            ):
                return

            self._peer_retry_attempts[remote_peer_id] = min(attempt + 1, 5)
            logging.info("P2P: recovering WebRTC transport to peer %s", remote_peer_id)

            await self._dispose_peer_connection(remote_peer_id)

            if (
                self._p2p_shutting_down
                or self.my_peer_id is None
                or remote_peer_id not in self.peers
            ):
                return

            pc = self._create_peer_connection(remote_peer_id)
            self.peer_connections[remote_peer_id] = pc

            if self.my_peer_id < remote_peer_id:
                channel = pc.createDataChannel("cliptext")
                self.data_channels[remote_peer_id] = channel
                self._setup_data_channel(remote_peer_id, channel)
                await self._create_offer(remote_peer_id)

    def _cancel_peer_connection_deadline(self, peer_id: str) -> None:
        handle = self._peer_connection_deadlines.pop(peer_id, None)
        if handle is not None:
            handle.cancel()

    def _peer_connection_timed_out(self, peer_id: str, pc: RTCPeerConnection) -> None:
        # A replaced connection's timer must never touch its successor.
        if self.peer_connections.get(peer_id) is not pc:
            return
        self._peer_connection_deadlines.pop(peer_id, None)
        if self._p2p_shutting_down or self.disconnected or peer_id not in self.peers:
            return
        channel = self.data_channels.get(peer_id)
        if channel is not None and channel.readyState == "open":
            return
        logging.warning(
            "P2P: peer %s data channel did not open within %ss "
            "(connection=%s, ice=%s, signaling=%s); scheduling recovery",
            peer_id, P2P_CONNECTION_TIMEOUT_SEC,
            pc.connectionState, pc.iceConnectionState, pc.signalingState,
        )
        self.schedule_task(self._recover_peer_transport(peer_id, pc))

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

        @pc.on("connectionstatechange")
        def on_connectionstatechange():
            try:
                state = pc.connectionState
            except Exception:
                return
            if state in ("failed", "closed"):
                self.schedule_task(self._recover_peer_transport(remote_peer_id, pc))

        @pc.on("datachannel")
        def on_datachannel(channel):
            if self.peer_connections.get(remote_peer_id) is not pc:
                channel.close()
                return
            # This fires when the remote side creates a datachannel
            self.data_channels[remote_peer_id] = channel
            self._setup_data_channel(remote_peer_id, channel)

        self._cancel_peer_connection_deadline(remote_peer_id)
        self._peer_connection_deadlines[remote_peer_id] = self.loop.call_later(
            P2P_CONNECTION_TIMEOUT_SEC, self._peer_connection_timed_out, remote_peer_id, pc
        )
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
        Replaces any negotiated RTCPeerConnection before applying the SDP:
        recovery sends a full new offer; applying it on an already-connected
        PC leaves ICE/datachannel mismatched (remote shows Peers: 1, local 0).
        """
        if self._p2p_shutting_down:
            return
        # Ignore delayed/stale OFFERs for peers no longer present in the latest PEER_LIST.
        # Startup guard: allow early signaling before ASSIGNED_ID/PEER_LIST is established.
        if self.my_peer_id is not None and self.peers and from_peer_id not in self.peers:
            logging.debug("Ignoring stale OFFER for removed peer: %s", from_peer_id)
            return
        lock = self._get_peer_lock(from_peer_id)
        async with lock:
            # TOCTOU guard: PEER_LIST can change after the outer fast-path check.
            if self.my_peer_id is not None and self.peers and from_peer_id not in self.peers:
                logging.debug("Ignoring stale OFFER for removed peer (in-lock): %s", from_peer_id)
                return
            pc = self.peer_connections.get(from_peer_id)
            # Keep the untouched room-list placeholder and its early candidates.
            if pc is not None and not (
                pc.signalingState == "stable"
                and pc.remoteDescription is None
                and pc.connectionState == "new"
            ):
                await self._dispose_peer_connection(from_peer_id)
                pc = None
            if pc is None:
                pc = self._create_peer_connection(from_peer_id)
                self.peer_connections[from_peer_id] = pc

            desc = RTCSessionDescription(sdp=offer["sdp"], type=offer["type"])
            await pc.setRemoteDescription(desc)
            await self._flush_pending_ice(from_peer_id, pc)

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
        async with self._get_peer_lock(from_peer_id):
            await self._apply_answer(from_peer_id, answer)

    async def _apply_answer(self, from_peer_id: str, answer: dict):
        """
        Handle an incoming ANSWER to our previously sent OFFER.
        """
        pc = self.peer_connections.get(from_peer_id)
        if not pc:
            logging.warning(f"No peer connection exists for id={from_peer_id}, ignoring ANSWER.")
            return
        if getattr(pc, "connectionState", "") in ("failed", "closed"):
            logging.debug("Ignoring ANSWER for dead peer connection: %s", from_peer_id)
            return
        if pc.signalingState != "have-local-offer":
            return
        desc = RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
        await pc.setRemoteDescription(desc)
        await self._flush_pending_ice(from_peer_id, pc)

    async def _handle_ice_candidate(self, from_peer_id: str, candidate_data: dict):
        async with self._get_peer_lock(from_peer_id):
            await self._apply_ice_candidate(from_peer_id, candidate_data)

    async def _flush_pending_ice(self, peer_id, pc):
        for candidate in self._pending_ice.pop(peer_id, []):
            await pc.addIceCandidate(candidate)

    async def _apply_ice_candidate(self, from_peer_id: str, candidate_data: dict):
        """
        Handle an incoming ICE candidate from the remote peer.
        """
        pc = self.peer_connections.get(from_peer_id)
        if not pc:
            logging.warning(
                f"No peer connection exists for id={from_peer_id}, ignoring ICE_CANDIDATE."
            )
            return
        if getattr(pc, "connectionState", "") in ("failed", "closed"):
            logging.debug("Ignoring ICE candidate for dead peer connection: %s", from_peer_id)
            return

        parsed_candidate = P2PManager.parse_ice_candidate_line(candidate_data.get("candidate"))
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
        if pc.remoteDescription is None:
            pending = self._pending_ice.setdefault(from_peer_id, [])
            if len(pending) < 256:
                pending.append(ice_candidate)
            return
        await pc.addIceCandidate(ice_candidate)

    def _setup_data_channel(self, remote_peer_id: str, channel: RTCDataChannel):
        """
        Set up handlers for an RTCDataChannel (open, message, close, error).
        """

        @channel.on("open")
        def on_open():
            if self.data_channels.get(remote_peer_id) is not channel:
                return
            self._cancel_peer_connection_deadline(remote_peer_id)
            self._peer_retry_attempts.pop(remote_peer_id, None)
            self._sync_live_connections_count()
            channel.send(capability_message(self.config))

        if channel.readyState == "open":
            on_open()

        @channel.on("message")
        def on_message(message):
            if self.data_channels.get(remote_peer_id) is not channel:
                return
            self._receive(message, remote_peer_id)

        @channel.on("close")
        def on_close():
            if self.data_channels.get(remote_peer_id) is not channel:
                return
            self._drop_peer_fragments(remote_peer_id)
            pc = self.peer_connections.get(remote_peer_id)
            self._sync_live_connections_count()
            self.schedule_task(self._recover_peer_transport(remote_peer_id, pc))

        @channel.on("error")
        def on_error(e):
            logging.error(f"[data] Data channel error with {remote_peer_id}: {e}")
            self._sync_live_connections_count()

    def _on_local_change(self):
        # Called on the clipboard monitor thread. Invalidate sends immediately;
        # mutate receive buffers on their owning asyncio loop.
        self.reset_sending_fragment_id()
        self.loop.call_soon_threadsafe(self.reset_receiving_fragments)

    def can_send_content(self, size):
        return any(channel.readyState == "open" and allows_content(self._peer_receive_limits.get(peer), size)
                   for peer, channel in self.data_channels.copy().items())

    def send(self, payload: str, payload_type: str = "text", is_current=lambda: True, content_size_bytes=None):
        self.schedule_task(self._send(payload, payload_type, self._send_generation, is_current, content_size_bytes))

    def reset_sending_fragment_id(self):
        self._send_generation += 1
        self.sending_fragment_id = ""
        self.sending_fragment_stats = None

    async def _send(self, payload: str, payload_type: str = "text", generation=None, is_current=lambda: True,
                    content_size_bytes=None):
        if generation is None:
            generation = self._send_generation

        def check_current():
            if (not is_current() or generation != self._send_generation or self.disconnected
                    or not self.config.data.get("send_clipboard", True)):
                raise TransferSuperseded()

        transfer_id = str(uuid.uuid4())
        try:
            check_current()
            if not valid_size(content_size_bytes):
                content_size_bytes = await asyncio.to_thread(content_size, payload, payload_type)
            check_current()
            if not self.can_send_content(content_size_bytes):
                logging.info("No connected peer accepts this clipboard content size")
                return
            # Hash/encode/encrypt can be large. Keep the receive loop available.
            payload_hash = await asyncio.to_thread(self.clipboard_manager.hash_clipboard, payload)
            check_current()
            if payload_hash == self.clipboard_manager.previous_clipboard_hash:
                return
            self.reset_receiving_fragments()

            recipients = [ch for peer, ch in self.data_channels.items()
                          if ch.readyState == "open" and allows_content(self._peer_receive_limits.get(peer), content_size_bytes)]
            recipient_ids = {id(ch): peer for peer, ch in self.data_channels.items()}
            encrypted = bool(self.config.data["cipher_enabled"])
            groups = [(flag, [ch for ch in recipients if bool(getattr(ch, "_cc_binary", False)) == flag])
                      for flag in (False, True)]

            def prepare():
                prepared_groups = []
                legacy_raw_size = len(payload.encode("utf-8"))
                for use_binary, channels in groups:
                    if not channels:
                        continue
                    check_current()
                    raw_size = legacy_raw_size
                    if use_binary:
                        def measure_raw_size(size):
                            nonlocal raw_size
                            raw_size = size
                        try:
                            prepared = binary.encode_content(payload, payload_type,
                                self.cipher_manager if encrypted else None, on_raw_size=measure_raw_size)
                            fragments = [prepared[i:i + FRAGMENT_SIZE] for i in range(0, len(prepared), FRAGMENT_SIZE)]
                        except ValueError as error:
                            if str(error) != "Binary header too large":
                                raise
                            fragments = []
                        if not fragments or len(fragments) > 65536:
                            use_binary = False
                            raw_size = legacy_raw_size
                            prepared = (CipherManager.encode_to_json_string(**self.cipher_manager.encrypt(payload))
                                        if encrypted else payload)
                            fragments = self.fragment_string(prepared, check_current=check_current)
                    else:
                        prepared = (CipherManager.encode_to_json_string(**self.cipher_manager.encrypt(payload))
                                    if encrypted else payload)
                        fragments = self.fragment_string(prepared, check_current=check_current)
                    check_current()
                    prepared_groups.append((use_binary, channels, fragments, raw_size))
                return prepared_groups

            if payload_type == "text" and len(payload) <= 65536:
                prepared_groups = await asyncio.to_thread(prepare)
            else:
                async with self._preparation_lock:
                    check_current()
                    prepared_groups = await asyncio.to_thread(prepare)
            check_current()
            payload = None
            self.sending_fragment_id = transfer_id

            def progress(index, total):
                if self.sending_fragment_id == transfer_id and generation == self._send_generation:
                    self.sending_fragment_stats = f"{index}/{total}"

            async def send_group(use_binary, channels, fragments, raw_size):
                metadata = dict(id=transfer_id, isFragmented=len(fragments) > 1,
                                index=0, totalFragments=len(fragments),
                                combinedRawPayloadSizeInBytes=raw_size, contentSizeBytes=content_size_bytes)
                return await send_shared_fragments(
                    fragments, channels, metadata, payload_type, check_current, progress,
                    lambda ch: allows_content(self._peer_receive_limits.get(recipient_ids[id(ch)]), content_size_bytes),
                    (lambda part, meta: binary.encode_frame(part, payload_type, meta, encrypted)) if use_binary else None,
                )

            completed = sum(await asyncio.gather(*(send_group(*group) for group in prepared_groups)))
            if not completed:
                return
            check_current()
            self.clipboard_manager.previous_clipboard_hash = payload_hash
        except TransferSuperseded:
            pass
        except Exception as e:
            logging.error(f"Failed to send data: {e}")
        finally:
            if self.sending_fragment_id == transfer_id:
                self.sending_fragment_id = ""
                self.sending_fragment_stats = None

    def _discard_fragment_id(self, fragment_id):
        self._discarded_fragments[fragment_id] = None
        self._discarded_fragments.move_to_end(fragment_id)
        while len(self._discarded_fragments) > 1024:
            self._discarded_fragments.popitem(last=False)

    def reset_receiving_fragments(self):
        for fragment_id in self.receiving_fragments:
            self._discard_fragment_id(fragment_id)
        self.receiving_fragments.clear()
        self.receiving_fragment_stats = None

    def _drop_peer_fragments(self, peer_id):
        self._peer_receive_limits.pop(peer_id, None)
        for fid, entry in list(self.receiving_fragments.items()):
            if entry.get("peer") == peer_id:
                self._discard_fragment_id(fid)
                self.receiving_fragments.pop(fid, None)
        if not self.receiving_fragments:
            self.receiving_fragment_stats = None

    def _prune_stale_receiving_fragments(self) -> None:
        """Drop partial fragment buffers idle for P2P_FRAGMENT_TTL_SEC.
        Why: if a peer disconnects mid-transfer, the final fragment never arrives
        and the buffer would leak indefinitely otherwise.
        """
        if not self.receiving_fragments:
            return
        now = time.monotonic()
        stale = [
            fid
            for fid, entry in self.receiving_fragments.items()
            if isinstance(entry, dict)
            and (now - entry.get("last_received_at", now)) > P2P_FRAGMENT_TTL_SEC
        ]
        for fid in stale:
            logging.debug("P2P: dropping stale fragment buffer %s", fid)
            self.receiving_fragments.pop(fid, None)
            self._discard_fragment_id(fid)
        if not self.receiving_fragments:
            self.receiving_fragment_stats = None

    def _receive(self, frame: any, peer_id=None) -> str:
        generation = self._send_generation
        try:
            body = binary.decode_frame(frame) if isinstance(frame, bytes) else json.loads(frame)
            is_binary = body.get("_cc_binary") is True
            if isinstance(body, dict) and body.get("_cc_keepalive") is True:
                channel = self.data_channels.get(peer_id)
                if channel is not None:
                    caps = body.get("capabilities")
                    channel._cc_binary = (isinstance(caps, dict) and caps.get("version") == 1
                                          and isinstance(caps.get("transferFormats"), list)
                                          and "ccb1" in caps["transferFormats"])
                read_capability(body, self._peer_receive_limits, peer_id)
                return
            if not self.config.data.get("receive_clipboard", True):
                self.reset_receiving_fragments()
                return
            payload = body["payload"]
            payload_type = body.get("type", "text")
            metadata = body.get("metadata")
            if metadata is not None:
                fid = metadata["id"]
                if fid in self._discarded_fragments:
                    return
                total, index = metadata["totalFragments"], metadata["index"]
                if (not isinstance(total, int) or not isinstance(index, int)
                        or total < 1 or not 0 <= index < total):
                    raise ValueError("Invalid fragment metadata")
                if fid not in self.receiving_fragments and index != 0:
                    return  # Canceled/expired tails cannot resurrect a transfer.
            # Legacy raw sizes include Base64/JSON overhead. Without an
            # original-content size, defer to decoded-content validation.
            if not allows_content(receive_limit(self.config), metadata_size(metadata)):
                if metadata:
                    self.receiving_fragments.pop(metadata["id"], None)
                    self._discard_fragment_id(metadata["id"])
                if not self.receiving_fragments:
                    self.receiving_fragment_stats = None
                logging.debug("Incoming clipboard content exceeds the local size limit")
                return

            if metadata is None or metadata["index"] == 0:
                self.reset_sending_fragment_id()
                self.clipboard_manager.cancel_preparation()
                generation = self._send_generation

            # Fragmented message handling
            if metadata is not None and metadata["isFragmented"]:
                self._prune_stale_receiving_fragments()
                self.receiving_fragment_stats = (
                    f"{metadata['index'] + 1}/{metadata['totalFragments']}"
                )
                if metadata["id"] in self.receiving_fragments:
                    entry = self.receiving_fragments[metadata["id"]]
                    if (entry["peer"] != peer_id or len(entry["fragments"]) != metadata["totalFragments"]
                            or entry["type"] != payload_type or entry.get("binary", False) != is_binary
                            or entry.get("encrypted") != body.get("encrypted")):
                        self.reset_receiving_fragments()
                        return
                    if entry["generation"] != self._send_generation:
                        self.reset_receiving_fragments()
                        return
                    generation = entry["generation"]
                    if is_binary:
                        if (metadata["index"] != entry["next_index"] or metadata_size(metadata) != entry["size"]
                                or entry["bytes"] + len(payload) > entry["size"] + binary.MAX_HEADER + 64):
                            raise ValueError("Invalid binary fragment sequence or size")
                        entry["next_index"] += 1
                        entry["bytes"] += len(payload)
                    entry["fragments"][metadata["index"]] = payload
                    entry["last_received_at"] = time.monotonic()
                    if metadata["index"] == metadata["totalFragments"] - 1:
                        if all(s != "" for s in entry["fragments"]):
                            payload = (b"" if is_binary else "").join(entry["fragments"])
                            self.receiving_fragments.pop(metadata["id"], None)
                            self._discard_fragment_id(metadata["id"])
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
                    self.receiving_fragments[metadata["id"]] = {
                        "last_received_at": time.monotonic(),
                        "peer": peer_id, "type": payload_type, "generation": generation,
                        "binary": is_binary, "encrypted": body.get("encrypted"),
                        "next_index": 1, "bytes": len(payload), "size": metadata_size(metadata),
                        "fragments": [""] * metadata["totalFragments"],
                    }
                    self.receiving_fragments[metadata["id"]]["fragments"][
                        metadata["index"]
                    ] = payload
                    return

            if generation != self._send_generation:
                return
            self.reset_receiving_fragments()
            if is_binary:
                if body["encrypted"] != bool(self.config.data["cipher_enabled"]):
                    raise ValueError("Encryption settings differ between devices")
                payload = binary.decode_content(payload, payload_type,
                    self.cipher_manager if body["encrypted"] else None, receive_limit(self.config))
            elif self.config.data["cipher_enabled"]:
                payload = self.cipher_manager.decrypt(
                    **CipherManager.decode_from_json_string(payload)
                )

            if generation != self._send_generation:
                return
            if self.clipboard_manager.has_clipboard_changed(payload):
                self.reset_receiving_fragments()
                self.clipboard_manager.base64_to_clipboard(
                    base64_string=payload, type_=payload_type,
                    is_current=lambda: generation == self._send_generation
                )
        except json.decoder.JSONDecodeError:
            self.reset_receiving_fragments()
            logging.error("If cipher is enabled, please make sure it is enabled on all devices")
        except Exception as e:
            self.reset_receiving_fragments()
            logging.error(f"Failed to receive data: {e}")

    @staticmethod
    def fragment_string(s: str, fragment_size: int = FRAGMENT_SIZE, check_current=lambda: None) -> list[str]:
        """
        Splits a string into a list of fragments, each with a maximum size of `fragment_size` bytes.

        Args:
            s (str): The string to fragment.
            fragment_size (int): The maximum size of each fragment in bytes.

        Returns:
            list[str]: A list of string fragments.
        """
        if fragment_size < 4:
            raise ValueError("fragment_size must allow a complete UTF-8 character (at least 4 bytes)")
        encoded = s.encode("utf-8")
        fragments = []
        start = 0
        while start < len(encoded):
            check_current()
            end = min(start + fragment_size, len(encoded))
            while end < len(encoded) and encoded[end] & 0xC0 == 0x80:
                end -= 1
            fragments.append(encoded[start:end].decode("utf-8"))
            start = end
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
            raise ValueError("Not a valid ICE candidate line (must start with 'candidate:').")

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
