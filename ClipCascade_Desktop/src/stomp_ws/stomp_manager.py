import json
import logging
import time


from interfaces.ws_interface import WSInterface
from stomp_ws.client import Client
from core.config import Config
from utils.cipher_manager import CipherManager
from utils.protocol_v2 import (
    ReplayCache,
    build_transport_frame,
    ensure_device_id,
    extract_transport_envelope,
    unwrap_inbound,
    wrap_outbound,
)
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
        self.replay_cache = ReplayCache()
        # One rejection notification per process; see _notify_rejection_once.
        self._rejection_notified = False
        self.sys_tray: TaskbarPanel = None
        self.first_conn_lost = True
        self.is_login_phase = is_login_phase
        self.client = None
        self.is_connected = False
        self.disconnected = False
        self.is_auto_reconnecting = False

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
            ensure_device_id(self.config.data)
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
                    body = wrap_outbound(
                        payload=payload,
                        payload_type=payload_type,
                        config_data=self.config.data,
                        cipher_manager=self.cipher_manager,
                        cipher_enabled=bool(self.config.data["cipher_enabled"]),
                    )
                    # Persist device_id / send_counter for durable replay resistance.
                    self.config.save()
                    # The server relays only {payload, type, metadata}, so the
                    # envelope travels inside payload or it does not arrive.
                    frame = build_transport_frame(body, payload_type=payload_type)
                    self.client.send(
                        destination=SEND_DESTINATION, body=json.dumps(frame)
                    )
        except Exception as e:
            logging.error(f"Failed to send data: {e}")

    def _receive(self, frame: any) -> str:
        try:
            if self.is_connected:
                body = json.loads(frame.body)
                envelope = extract_transport_envelope(body)
                payload, payload_type = unwrap_inbound(
                    envelope,
                    cipher_manager=self.cipher_manager,
                    cipher_enabled=bool(self.config.data["cipher_enabled"]),
                    replay_cache=self.replay_cache,
                    local_device_id=self.config.data.get("device_id") or None,
                    allow_legacy_v1=bool(self.config.data.get("allow_legacy_v1")),
                )

                if self.clipboard_manager.has_clipboard_changed(payload):
                    self.clipboard_manager.base64_to_clipboard(
                        base64_string=payload, type_=payload_type
                    )
        except json.decoder.JSONDecodeError:
            logging.error(
                "If cipher is enabled, please make sure it is enabled on all devices"
            )
        except ValueError as e:
            logging.warning(f"Rejected inbound clipboard message: {e}")
            self._notify_rejection_once(e)
        except Exception as e:
            logging.error(f"Failed to receive data: {e}")

    def _notify_rejection_once(self, error: ValueError) -> None:
        """
        Surface a rejected-message reason to the user, once per connection.

        Every inbound message being refused looks exactly like "sync is quietly
        broken", which is how an envelope-stripping relay went unnoticed. A
        warning in a log file nobody reads is not enough for a failure that
        stops the product working.
        """
        if self._rejection_notified:
            return
        reason = str(error)
        if "legacy v1" not in reason and "un-bound" not in reason:
            return
        self._rejection_notified = True
        self.notification_manager.notify(
            title=f"{APP_NAME}: Incoming Clipboard Rejected ⚠️",
            message=(
                "Messages are arriving without protocol v2 metadata. Either a "
                "device is still below 3.2.0, or the server is dropping the "
                "envelope. Update every device, then reconnect."
            ),
        )

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
