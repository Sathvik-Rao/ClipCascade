import json
import logging


from interfaces.ws_interface import WSInterface
from utils import binary_protocol as binary
from utils.relay_recipients import RelayRecipients
from utils.reconnect import ReconnectMixin
from stomp_ws.client import Client
from core.config import Config
from utils.cipher_manager import CipherManager
from clipboard.clipboard_manager import ClipboardManager
from utils.clipboard_echoes import ClipboardEchoes
from utils.transfer_limits import (LIMIT_HEADER, SIZE_FIELD, receive_limit_header, valid_size,
                                  metadata_size, allows_content, receive_limit, content_size)
from utils.notification_manager import NotificationManager
from utils.request_manager import RequestManager
from utils.ssl_helper import websocket_sslopt_for_config
from core.constants import *

if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
    from cli.tray import TaskbarPanel
else:
    from gui.tray import TaskbarPanel


class STOMPManager(ReconnectMixin, WSInterface):
    def __init__(self, config: Config, is_login_phase=True):
        self.config = config
        self._relay_recipients = RelayRecipients()
        self._transfer_generation = 0
        self._sent_echoes = ClipboardEchoes()
        self.clipboard_manager = ClipboardManager(self.config)
        self.cipher_manager = CipherManager(self.config)
        self.notification_manager = NotificationManager(self.config)
        self.sys_tray: TaskbarPanel = None
        self.first_conn_lost = True
        self.is_login_phase = is_login_phase
        self.client = None
        self.is_connected = False
        self.disconnected = False
        self.is_auto_reconnecting = False
        self._init_reconnect()

    def set_tray_ref(self, sys_tray: TaskbarPanel):
        """
        Sets the system tray reference.
        """
        self.sys_tray = sys_tray
        self.clipboard_manager.set_tray_ref(sys_tray)

    def get_total_timeout(self):
        """
        Returns the total timeout value in milliseconds."""
        return (RECONNECT_WS_TIMER * 1000) + WEBSOCKET_TIMEOUT

    def get_stats(self):
        if not self.is_connected:
            return "Disconnected" if self.disconnected else "Reconnecting…"
        loading = self.clipboard_manager.get_loading_status()
        if loading:
            return f"Connected | {loading}"
        return "Connected"

    def _connect_once(self) -> tuple[bool, str]:
        try:
            if self.is_connected:
                return True, ""
            if self.client is not None:
                self.client.disconnect()
            cache = self._relay_recipients = RelayRecipients()
            client = Client(
                self.config.data["websocket_url"],
                headers={
                    "Cookie": RequestManager.format_cookie(
                        self.config.data["cookie"]
                    )
                },
                on_close_callback=lambda: self._on_close(client),
                sslopt=websocket_sslopt_for_config(self.config),
            )
            self.client = client
            client.connect(
                headers={"x-clipcascade-recipient-updates": "1", "x-clipcascade-binary": "ccb1", "x-clipcascade-no-self-echo": "true", LIMIT_HEADER: receive_limit_header(self.config)},
                timeout=WEBSOCKET_TIMEOUT,
                connectCallback=lambda _: client.subscribe(  # receive event
                    destination=SUBSCRIPTION_DESTINATION,
                    callback=lambda frame: self._receive(frame, cache) if self.client is client and not self.disconnected else None,
                ),
            )
            if self.disconnected:
                self.disconnect()
                return False, "Websocket disconnected"

            # logging.info("Websocket connected")
            self.is_connected = True
            if not client.connected:
                raise ConnectionError("STOMP connection closed during handshake")
            self.is_auto_reconnecting = False
            self._reconnect_attempts = 0
            if not self.first_conn_lost:
                self.first_conn_lost = True
                self.notification_manager.notify(
                    title=f"{APP_NAME}: WebSocket Connection Restored 🔗",
                    message="Connection re-established",
                )

            # send event
            self.clipboard_manager.on_copy(self.send, self._on_local_change)
            return True, "Websocket connected"
        except Exception as e:
            self.is_connected = False
            if self.client is not None:
                try:
                    self.client.disconnect()
                except Exception:
                    logging.exception("Failed to close unsuccessful STOMP connection")
            msg = f"Failed to connect websocket: {e}"
            logging.error(msg)
            return False, msg

    def _on_close(self, client=None):
        if client is not None and client is not self.client:
            return
        self._relay_recipients.reset()
        self._transfer_generation += 1
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

    def _on_local_change(self):
        self._transfer_generation += 1

    def send(self, payload: str, payload_type: str = "text", is_current=lambda: True, content_size_bytes=None):
        generation = self._transfer_generation
        client = self.client
        if not is_current() or not self.config.data.get("send_clipboard", True):
            return
        try:
            if self.is_connected:
                payload_hash = self.clipboard_manager.hash_clipboard(payload, payload_type)
                if payload_hash != self.clipboard_manager.previous_clipboard_hash:
                    if not valid_size(content_size_bytes):
                        content_size_bytes = content_size(payload, payload_type)
                    plan = self._relay_recipients.get()
                    if plan is None:
                        plan = RequestManager(self.config).binary_recipients()
                    encrypted = bool(self.config.data["cipher_enabled"])
                    # Construct only the representations required by this snapshot.
                    messages = []
                    if plan is not None and plan[True]:
                        try:
                            raw = binary.encode_content(payload, payload_type, self.cipher_manager if encrypted else None)
                        except ValueError as error:
                            if str(error) != "Binary header too large":
                                raise
                            plan[False].extend(plan[True])
                            plan[True] = []
                        else:
                            body = binary.encode_frame(raw, payload_type, {SIZE_FIELD: content_size_bytes}, encrypted)
                            messages.append(("/app/clipbinary", body, {"content-type": binary.CONTENT_TYPE,
                                "x-clipcascade-recipients": ",".join(plan[True])}, None))
                    if plan is None or plan[False]:
                        echo_key = None
                        prepared = binary.legacy_content(payload, payload_type)
                        if encrypted:
                            envelope = self.cipher_manager.encrypt(prepared)
                            echo_key = (payload_type, "encrypted", envelope["nonce"], envelope["tag"])
                            prepared = CipherManager.encode_to_json_string(**envelope)
                        body = json.dumps({"payload": prepared, "type": payload_type,
                                           "metadata": {SIZE_FIELD: content_size_bytes}})
                        headers = {} if plan is None else {"x-clipcascade-recipients": ",".join(plan[False])}
                        messages.append((SEND_DESTINATION, body, headers, echo_key))
                    for destination, body, headers, echo_key in messages:
                        if (not is_current() or generation != self._transfer_generation or not self.is_connected
                                or client is not self.client or not self.config.data.get("send_clipboard", True)):
                            return
                        if echo_key is not None:
                            self._sent_echoes.remember(echo_key)
                        try:
                            client.send(destination=destination, body=body, headers=headers)
                        except Exception:
                            if echo_key is not None:
                                self._sent_echoes.consume(echo_key)
                            raise
                    if generation == self._transfer_generation and client is self.client:
                        self.clipboard_manager.previous_clipboard_hash = payload_hash
        except Exception as e:
            logging.error(f"Failed to send data: {e}")

    def _receive(self, frame: any, recipient_cache=None) -> str:
        # Controls must be accepted before clipboard permissions or connection-ready checks.
        parsed_body = None
        if not isinstance(frame.body, bytes):
            try:
                parsed_body = json.loads(frame.body)
                if (recipient_cache or self._relay_recipients).accept(parsed_body):
                    return
            except (ValueError, TypeError):
                pass
        generation = self._transfer_generation
        if not self.config.data.get("receive_clipboard", True):
            return
        try:
            if self.is_connected:
                is_binary = isinstance(frame.body, bytes)
                body = binary.decode_frame(frame.body) if is_binary else parsed_body
                if not allows_content(receive_limit(self.config), metadata_size(body.get("metadata"))):
                    logging.info("Incoming clipboard content exceeds the local size limit")
                    return
                payload = body["payload"]
                payload_type = body.get("type", "text")
                if is_binary:
                    if body["encrypted"] != bool(self.config.data["cipher_enabled"]):
                        raise ValueError("Encryption settings differ between devices")
                    payload = binary.decode_content(payload, payload_type,
                        self.cipher_manager if body["encrypted"] else None, receive_limit(self.config))
                elif self.config.data["cipher_enabled"]:
                    envelope = CipherManager.decode_from_json_string(payload)
                    if self._sent_echoes.consume((payload_type, "encrypted", envelope["nonce"], envelope["tag"])):
                        return
                    payload = self.cipher_manager.decrypt(**envelope)
                    del envelope

                payload = binary.original_content(payload, payload_type)
                if generation != self._transfer_generation:
                    return
                if self.clipboard_manager.has_clipboard_changed(payload, payload_type):
                    self._on_local_change()
                    generation = self._transfer_generation
                    self.clipboard_manager.cancel_preparation()
                    self.clipboard_manager.content_to_clipboard(
                        content=payload, type_=payload_type,
                        is_current=lambda: generation == self._transfer_generation
                    )
        except json.decoder.JSONDecodeError:
            logging.error(
                "If cipher is enabled, please make sure it is enabled on all devices"
            )
        except Exception as e:
            logging.error(f"Failed to receive data: {e}")

    def disconnect(self):
        self._relay_recipients.reset()
        self._on_local_change()
        self._stop_reconnect()
        self.is_connected = False
        try:
            self.clipboard_manager.previous_clipboard_hash = 0
            self.disconnected = True
            self.first_conn_lost = True
            try:
                self.client.disconnect()
                self.is_connected = False
                logging.info("Websocket disconnected")
            except Exception as e:
                pass  # silent catch
            self.clipboard_manager.stop()
        except Exception as e:
            logging.error(f"Failed to disconnect websocket: {e}")
