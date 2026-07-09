import json
import logging
import time


from interfaces.ws_interface import WSInterface
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


class STOMPManager(WSInterface):
    def __init__(self, config: Config, is_login_phase=True):
        self.config = config
        self.clipboard_manager = ClipboardManager(self.config)
        self.cipher_manager = CipherManager(self.config)
        self.notification_manager = NotificationManager(self.config)
        self.request_manager = RequestManager(self.config)
        self.sys_tray: TaskbarPanel = None
        self.first_conn_lost = True
        self.is_login_phase = is_login_phase
        self.client = None
        self.is_connected = False
        self.disconnected = False
        self.is_auto_reconnecting = False
        # Guards the "session expired" notification so a credential-less client
        # is told once, not on every 10s reconnect attempt.
        self.session_expired_notified = False

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
        return None

    def connect(self) -> tuple[bool, str]:
        try:
            if self.is_connected:
                return True, ""
            # Honor an explicit user disconnect: an auto-reconnect thread that
            # was already sleeping when the user disconnected must not wake up
            # and silently re-login/reconnect behind them. manual_reconnect()
            # clears this flag before calling, so intentional reconnects still
            # proceed.
            if self.disconnected:
                return False, "Websocket disconnected"
            # A restarted server drops its in-memory sessions, invalidating the
            # stored cookie. Refresh the session before (re)connecting so the
            # handshake is not 302-redirected to the login page — which the
            # underlying websocket client would follow into an invalid "http"
            # scheme and never recover from. Skipped during the initial login
            # phase, where authenticate_and_connect() already owns the login.
            if not self.is_login_phase and self.config.data.get("cookie"):
                if not self.request_manager.is_session_valid():
                    self._try_relogin()
            self.client = Client(
                self.config.data["websocket_url"],
                headers={
                    "Cookie": RequestManager.format_cookie(
                        self.config.data["cookie"]
                    )
                },
                on_close_callback=self._on_close,
                sslopt=websocket_sslopt_for_config(self.config),
            )
            self.client.connect(
                timeout=WEBSOCKET_TIMEOUT,
                connectCallback=lambda _: self.client.subscribe(  # receive event
                    destination=SUBSCRIPTION_DESTINATION,
                    callback=self._receive,
                ),
            )
            if self.disconnected:
                self.disconnect()
                return False, "Websocket disconnected"

            # logging.info("Websocket connected")
            self.is_connected = True
            self.is_auto_reconnecting = False
            self.session_expired_notified = False
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
            msg = f"Failed to connect websocket: {e}"
            logging.error(msg)
            return False, msg

    def _try_relogin(self) -> bool:
        """
        Recover an expired session before reconnecting.

        When the login password was persisted (Save Password) this silently
        re-authenticates and refreshes the cookie/CSRF token in place, so the
        following WebSocket connect uses a live session and syncing resumes with
        no user action. Without stored credentials it notifies the user once
        (they must re-login manually) and returns False.
        """
        if self.config.data.get("password") and self.config.data.get("username"):
            success, _msg, cookie = self.request_manager.login()
            if success and cookie:
                self.config.data["cookie"] = cookie
                self.config.data["csrf_token"] = self.request_manager.get_csrf_token()
                self.config.save()
                self.session_expired_notified = False
                logging.info("Session had expired; silently re-logged in")
                return True

        if not self.session_expired_notified:
            self.session_expired_notified = True
            self.notification_manager.notify(
                title=f"{APP_NAME}: Session Expired 🔒",
                message="Your session ended (the server may have restarted). "
                "Please re-login to resume clipboard syncing.",
            )
        return False

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
            time.sleep(RECONNECT_WS_TIMER)  # seconds
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
