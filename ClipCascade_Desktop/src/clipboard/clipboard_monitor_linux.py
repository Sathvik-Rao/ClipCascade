import logging
import os
import re
import subprocess
import threading
import time

from core.constants import *

try:
    from pywayland.protocol.ext_data_control_v1.ext_data_control_manager_v1 import (
        ExtDataControlManagerV1,
    )
    from pywayland.protocol.wayland.wl_seat import WlSeat
except (ImportError, ModuleNotFoundError) as e:
    logging.warning(
        f"pywayland protocol bindings not available: {e}. Falling back to polling mode."
    )
    ExtDataControlManagerV1 = None
    WlSeat = None

_callback_update = None
_clipboard_thread = None

_block_image_once = False

_is_gdk_running = False
_run_poll = threading.Event()


class _WaylandClipboardMonitor:
    def __init__(
        self,
        enable_image_monitoring=False,
        enable_file_monitoring=False,
    ):
        self.enable_image_monitoring = enable_image_monitoring
        self.enable_file_monitoring = enable_file_monitoring
        self.display = None
        self.data_control_manager = None
        self.data_device = None
        self.seat = None
        self.current_offer = None
        self.current_offer_mime_types = []
        self.running = False
        self.previous_clipboard = None

    def _handle_data_offer(self, offer):
        self.current_offer_mime_types = []

        def on_offer(offer_obj, mime_type):
            self.current_offer_mime_types.append(mime_type)

        offer.dispatcher["offer"] = on_offer

    def _handle_selection(self, offer):
        global _block_image_once

        if self.current_offer is not None:
            try:
                self.current_offer.destroy()
            except Exception:
                pass

        self.current_offer = offer

        if offer is None:
            return

        mime_types = self.current_offer_mime_types.copy()
        type_ = convert_mime_to_generic_type(mime_types)

        if type_ == "text":
            data = self._receive_data(offer, "text/plain;charset=utf-8")
            if data is None:
                data = self._receive_data(offer, "text/plain")
            if data:
                text = data.decode("utf-8")
                if text and text != self.previous_clipboard:
                    self.previous_clipboard = text
                    if _callback_update:
                        _callback_update("text", text)

        elif type_ == "image" and self.enable_image_monitoring:
            png_mime = next((m for m in mime_types if m.startswith("image/png")), None)
            if png_mime:
                data = self._receive_data(offer, png_mime)
            else:
                data = self._receive_data(offer, mime_types[0])

            if data and data != self.previous_clipboard:
                self.previous_clipboard = data
                if _callback_update and not _block_image_once:
                    _callback_update("image", data)
                else:
                    _block_image_once = False

        elif type_ == "files" and self.enable_file_monitoring:
            data = self._receive_data(offer, "text/uri-list")
            if data:
                files = data.decode("utf-8")
                files = files.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                files = [f.strip() for f in files if f.strip()]
                if files and files != self.previous_clipboard:
                    self.previous_clipboard = files
                    if _callback_update:
                        _callback_update("files", files)

    def _receive_data(self, offer, mime_type):
        read_fd, write_fd = os.pipe()
        try:
            offer.receive(mime_type, write_fd)
            os.close(write_fd)
            self.display.roundtrip()

            data = b""
            while True:
                chunk = os.read(read_fd, 4096)
                if not chunk:
                    break
                data += chunk
            return data if data else None
        except Exception as e:
            logging.error(f"Failed to receive clipboard data: {e}")
            return None
        finally:
            try:
                os.close(read_fd)
            except Exception:
                pass

    def start(self):
        try:
            from pywayland.client import Display

            self.display = Display()
            self.display.connect()

            registry = self.display.get_registry()

            def on_global(reg, name, interface, version):
                if interface == "ext_data_control_manager_v1":
                    self.data_control_manager = reg.bind(
                        name, ExtDataControlManagerV1, version
                    )
                elif interface == "wl_seat":
                    self.seat = reg.bind(name, WlSeat, version)

            registry.dispatcher["global"] = on_global

            self.display.roundtrip()

            if self.data_control_manager is None:
                logging.error(
                    "ext_data_control_v1 protocol not available. "
                    "Falling back to polling mode."
                )
                self.stop()
                return False

            if self.seat is None:
                logging.error("No wl_seat available. Falling back to polling mode.")
                self.stop()
                return False

            self.data_device = self.data_control_manager.get_data_device(self.seat)

            def on_data_offer(device, offer_id):
                self._handle_data_offer(offer_id)

            def on_selection(device, offer):
                self._handle_selection(offer)

            def on_primary_selection(device, offer):
                pass

            self.data_device.dispatcher["data_offer"] = on_data_offer
            self.data_device.dispatcher["selection"] = on_selection
            self.data_device.dispatcher["primary_selection"] = on_primary_selection

            self.running = True
            self.display.roundtrip()

            while self.running and _run_poll.is_set():
                self.display.dispatch(block=True)

            return True
        except Exception as e:
            logging.error(f"Failed to start Wayland clipboard monitor: {e}")
            self.stop()
            return False

    def stop(self):
        self.running = False
        if self.current_offer is not None:
            try:
                self.current_offer.destroy()
            except Exception:
                pass
            self.current_offer = None
        if self.data_device is not None:
            try:
                self.data_device.destroy()
            except Exception:
                pass
            self.data_device = None
        if self.data_control_manager is not None:
            try:
                self.data_control_manager.destroy()
            except Exception:
                pass
            self.data_control_manager = None
        if self.display is not None:
            try:
                self.display.disconnect()
            except Exception:
                pass
            self.display = None


_wayland_monitor = None


def _on_clipboard_changed(
    clipboard, event=None, enable_image_monitoring=False, enable_file_monitoring=False
):
    global _block_image_once

    # Files
    if enable_file_monitoring:
        uris = clipboard.wait_for_uris()
        if uris is not None and len(uris) > 0:
            if _callback_update:
                _callback_update("files", uris)
            return

    # Text
    text = clipboard.wait_for_text()
    if text is not None and len(text) > 0:
        if _callback_update:
            _callback_update("text", text)
        return

    # Image
    if enable_image_monitoring:
        pixbuf = clipboard.wait_for_image()
        if pixbuf is not None:
            if _block_image_once:
                _block_image_once = False
                return
            if _callback_update:
                success, buffer = pixbuf.save_to_bufferv("png")
                if success:
                    _callback_update("image", bytes(buffer))
                else:
                    logging.error("Failed to convert image(pixbuf) to buffer")
                return


def _monitor_x_wl_clipboard(
    x_mode: bool,
    enable_image_monitoring=False,
    enable_file_monitoring=False,
):
    global _block_image_once
    last_error = None
    previous_clipboard: str | bytes | list | None = None
    ignore_patterns = [
        r"target .+ not available",  # xclip pattern
        r"no suitable type of content copied",  # wl-clipboard pattern
    ]

    if x_mode:
        timeout = 0.3  # xclip seconds
    else:
        timeout = 1  # wl-clipboard seconds

    while _run_poll.is_set():
        if x_mode:
            success, mime_list = execute_command(
                "xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"
            )
        else:
            success, mime_list = execute_command("wl-paste", "-l")
        if not success:
            error_msg = f"Failed to retrieve MIME types: {mime_list}"
            if error_msg != last_error:
                logging.error(error_msg)
                last_error = error_msg
            time.sleep(timeout)
            continue

        mime_list = mime_list.decode("utf-8")
        mime_list = mime_list.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        mime_list = [m.strip() for m in mime_list if len(m.strip()) > 0]
        type_ = convert_mime_to_generic_type(mime_list)

        # Text
        if type_ == "text":
            if x_mode:
                success, text = execute_command(
                    "xclip", "-selection", "clipboard", "-o"
                )
            else:
                success, text = execute_command("wl-paste", "-n")
            if success:
                text = text.decode("utf-8")
                if len(text) > 0 and text != previous_clipboard:
                    previous_clipboard = text
                    if _callback_update:
                        _callback_update("text", text)
            else:
                error_msg = f"Failed to retrieve text content from clipboard. {text}"
                if error_msg != last_error:
                    if not any(
                        re.search(pattern, error_msg.lower())
                        for pattern in ignore_patterns
                    ):
                        logging.error(error_msg)
                    last_error = error_msg

        # Image
        if type_ == "image" and enable_image_monitoring:
            if x_mode:
                success, image = execute_command(
                    "xclip",
                    "-selection",
                    "clipboard",
                    "-t",
                    "image/png",
                    "-o",
                )
            else:
                success, image = execute_command("wl-paste", "-t", "image/png")
            if success:
                if image != previous_clipboard:
                    previous_clipboard = image
                    if _callback_update and not _block_image_once:
                        _callback_update("image", image)
                    else:
                        _block_image_once = False
            else:
                error_msg = f"Failed to retrieve image content from clipboard. {image}"
                if error_msg != last_error:
                    if not any(
                        re.search(pattern, error_msg.lower())
                        for pattern in ignore_patterns
                    ):
                        logging.error(error_msg)
                    last_error = error_msg

        # Files
        if type_ == "files" and enable_file_monitoring:
            if x_mode:
                success, files = execute_command(
                    "xclip",
                    "-selection",
                    "clipboard",
                    "-t",
                    "text/uri-list",
                    "-o",
                )
            else:
                success, files = execute_command(
                    "wl-paste", "-t", "text/uri-list", "-n"
                )
            if success:
                files = files.decode("utf-8")
                files = files.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                files = [f.strip() for f in files if len(f.strip()) > 0]
                if files != previous_clipboard:
                    previous_clipboard = files
                    if _callback_update:
                        _callback_update("files", files)
            else:
                error_msg = f"Failed to retrieve files content from clipboard. {files}"
                if error_msg != last_error:
                    if not any(
                        re.search(pattern, error_msg.lower())
                        for pattern in ignore_patterns
                    ):
                        logging.error(error_msg)
                    last_error = error_msg

        time.sleep(timeout)


def convert_mime_to_generic_type(mime_list):
    if "text/uri-list" in mime_list:
        return "files"

    if any(mime.startswith("image/") for mime in mime_list):
        return "image"

    text_mime = [
        "text/plain",
        "text/plain;charset=utf-8",
        "STRING",
        "TEXT",
        "COMPOUND_TEXT",
        "UTF8_STRING",
    ]
    if any(t_mime in mime_list for t_mime in text_mime):
        return "text"

    return "unknown"


def execute_command(*args) -> tuple:
    """
    Executes a command with the given arguments and returns the output or error.

    Parameters:
        *args: Variable-length argument list to be passed as the command and arguments.

    Returns:
        tuple: (success: bool, result: str)
               success is True if the command executed successfully, False otherwise.
               result is the output or error of the command.
    """
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    output, error = process.communicate()
    if process.returncode == 0:  # Success
        return (True, output)
    else:  # Failure
        return (False, error.decode())


def is_x_clipboard_owner():
    # Check if the X clipboard is owned by the current user
    return execute_command("xclip", "-selection", "clipboard", "-t", "TARGETS", "-o")[0]


def _start_clipboard_polling(enable_image_monitoring, enable_file_monitoring):
    if XMODE:
        x_clipboard_owner = is_x_clipboard_owner()
        if not x_clipboard_owner:
            logging.warning(
                "x-clip is not owned by the current user. Switching to wl-clipboard."
            )
        _monitor_x_wl_clipboard(
            x_mode=x_clipboard_owner,
            enable_image_monitoring=enable_image_monitoring,
            enable_file_monitoring=enable_file_monitoring,
        )
    else:
        _monitor_x_wl_clipboard(
            x_mode=XMODE,
            enable_image_monitoring=enable_image_monitoring,
            enable_file_monitoring=enable_file_monitoring,
        )


def _runner(enable_image_monitoring=False, enable_file_monitoring=False):
    global _is_gdk_running, _run_poll, _wayland_monitor
    _run_poll.set()

    if EXT_DATA_CONTROL_SUPPORT:
        _wayland_monitor = _WaylandClipboardMonitor(
            enable_image_monitoring=enable_image_monitoring,
            enable_file_monitoring=enable_file_monitoring,
        )
        if _wayland_monitor.start():
            return
        _wayland_monitor = None
        logging.warning(
            "ext_data_control_v1 unavailable. Falling back to polling mode."
        )

    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        from gi.repository import Gdk, Gtk

        if "x11" in str(type(Gdk.Display.get_default())).lower():
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clipboard.connect(
                "owner-change",
                lambda clip, event: _on_clipboard_changed(
                    clip, event, enable_image_monitoring, enable_file_monitoring
                ),
            )
            _is_gdk_running = True
            Gtk.main()
        else:
            logging.warning(
                f"Unsupported display server detected ${str(type(Gdk.Display.get_default())).lower()}. Starting polling mode for {detect_linux_display_server()} server as fallback."
            )
            _start_clipboard_polling(enable_image_monitoring, enable_file_monitoring)
    except Exception as e:
        logging.error(
            f"Failed to start clipboard monitor: Error {e}\nStarting polling mode for {detect_linux_display_server()} server as fallback."
        )
        _start_clipboard_polling(enable_image_monitoring, enable_file_monitoring)


def _start(enable_image_monitoring=False, enable_file_monitoring=False):
    global _clipboard_thread
    if not _clipboard_thread:
        _clipboard_thread = threading.Thread(
            target=_runner,
            args=(enable_image_monitoring, enable_file_monitoring),
            daemon=True,
        )
        _clipboard_thread.start()


def stop():
    global \
        _clipboard_thread, \
        _callback_update, \
        _block_image_once, \
        _run_poll, \
        _is_gdk_running, \
        _wayland_monitor
    if _clipboard_thread:
        if _wayland_monitor is not None:
            _wayland_monitor.stop()
            _wayland_monitor = None
        elif _is_gdk_running:
            import gi

            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk

            Gtk.main_quit()
            _is_gdk_running = False
        _run_poll.clear()
        _clipboard_thread.join()
        _clipboard_thread = None
        _callback_update = None
        _block_image_once = False
        logging.info("Clipboard monitor stopped")


def wait():
    global _clipboard_thread
    if _clipboard_thread:
        _clipboard_thread.join()


def enable_block_image_once():
    global _block_image_once
    _block_image_once = True


def on_update(callback, enable_image_monitoring=False, enable_file_monitoring=False):
    global _callback_update
    _callback_update = callback
    _start(enable_image_monitoring, enable_file_monitoring)
