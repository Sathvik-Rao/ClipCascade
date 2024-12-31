import json
import logging
import time


from stomp_ws.client import Client
from core.config import Config
from utils.cipher_manager import CipherManager
from clipboard.clipboard_manager import ClipboardManager
from utils.notification_manager import NotificationManager
from utils.request_manager import RequestManager
from core.constants import *

if PLATFORM.startswith(LINUX) and not XMODE:
    from cli.tray import TaskbarPanel
else:
    from gui.tray import TaskbarPanel


class STOMPManager:
    def __init__(self, config: Config, is_login_phase=True):
        self.config = config
        self.clipboard_manager = ClipboardManager(self.config)
        self.cipher_manager = CipherManager(self.config)
        self.notification_manager = NotificationManager(self.config)
        self.first_conn_lost = True
        self.is_login_phase = is_login_phase
        self.client = None
        self.is_connected = False
        self.disconnected = False
        self.is_auto_reconnecting = False
        self.sys_tray: TaskbarPanel = None

    def set_tray_ref(self, sys_tray: TaskbarPanel):
        """
        Sets the system tray reference.
        """
        self.sys_tray = sys_tray
        self.clipboard_manager.set_tray_ref(sys_tray)

    def get_total_timeout(self):
        """
        Returns the total timeout value in milliseconds."""
        return (RECONNECT_STOMP_TIMER * 1000) + WEBSOCKET_TIMEOUT

    def connect(self) -> tuple[bool, str]:
        try:
            if not self.is_connected:
                self.client = Client(
                    self.config.data["websocket_url"],
                    headers={
                        "Cookie": RequestManager.format_cookie(
                            self.config.data["cookie"]
                        )
                    },
                    on_close_callback=self._on_close,
                )
                self.client.connect(timeout=WEBSOCKET_TIMEOUT)
                if self.disconnected:
                    self.disconnect()
                    return False, "Websocket disconnected"

                # logging.info("Websocket connected")
                self.is_connected = True
                self.is_auto_reconnecting = False
                if not self.first_conn_lost:
                    self.first_conn_lost = True
                    self.notification_manager.notify(
                        title=f"{APP_NAME}: WebSocket Connection Restored 🔗",
                        message="Connection re-established",
                    )
                # receive event
                self.client.subscribe(
                    destination=SUBSCRIPTION_DESTINATION,
                    callback=self._receive,
                )
                # send event
                self.clipboard_manager.on_copy(self.send)
                return True, "Websocket connected"
        except Exception as e:
            msg = f"Failed to connect websocket: {e}"
            logging.error(msg)
            return False, msg

    def _on_close(self):
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
            time.sleep(RECONNECT_STOMP_TIMER)  # seconds
            self.connect()

    def send(self, payload: str, payload_type: str = "text"):
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

    def manual_reconnect(self):
        if not self.is_auto_reconnecting:
            self.disconnected = False
            self.connect()

    def disconnect(self):
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
