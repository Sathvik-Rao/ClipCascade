import json
import logging


from interfaces.ws_interface import WSInterface
from utils.reconnect import ReconnectMixin
from stomp_ws.client import Client
from core.config import Config
from utils.cipher_manager import CipherManager
from clipboard.clipboard_manager import ClipboardManager
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
        return "Connected" if self.is_connected else ("Disconnected" if self.disconnected else "Reconnecting…")

    def _connect_once(self) -> tuple[bool, str]:
        try:
            if self.is_connected:
                return True, ""
            if self.client is not None:
                self.client.disconnect()
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
                timeout=WEBSOCKET_TIMEOUT,
                connectCallback=lambda _: client.subscribe(  # receive event
                    destination=SUBSCRIPTION_DESTINATION,
                    callback=self._receive,
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
            self.clipboard_manager.on_copy(self.send)
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

    def send(self, payload: str, payload_type: str = "text"):
        if not self.config.data.get("send_clipboard", True):
            return
        try:
            if self.is_connected:
                if self.clipboard_manager.has_clipboard_changed(payload):
                    if self.config.data["cipher_enabled"]:
                        payload = CipherManager.encode_to_json_string(
                            **self.cipher_manager.encrypt(payload)
                        )
                    body = json.dumps({"payload": payload, "type": payload_type})
                    self.client.send(destination=SEND_DESTINATION, body=body)
        except Exception as e:
            logging.error(f"Failed to send data: {e}")

    def _receive(self, frame: any) -> str:
        if not self.config.data.get("receive_clipboard", True):
            return
        try:
            if self.is_connected:
                body = json.loads(frame.body)
                payload = body["payload"]
                payload_type = body.get("type", "text")
                if self.config.data["cipher_enabled"]:
                    payload = self.cipher_manager.decrypt(
                        **CipherManager.decode_from_json_string(payload)
                    )

                if self.clipboard_manager.has_clipboard_changed(payload):
                    self.clipboard_manager.base64_to_clipboard(
                        base64_string=payload, type_=payload_type
                    )
        except json.decoder.JSONDecodeError:
            logging.error(
                "If cipher is enabled, please make sure it is enabled on all devices"
            )
        except Exception as e:
            logging.error(f"Failed to receive data: {e}")

    def disconnect(self):
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
