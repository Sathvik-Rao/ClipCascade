import subprocess
import threading
import time
import pyperclip
import logging
import os

_callback_text = None
_clipboard_thread = None
logged_once = False


def _on_text_received(clipboard, text):
    global _callback_text
    if text is not None:
        _callback_text(text)


def _on_clipboard_changed(clipboard, event=None):
    global _callback_text

    if _callback_text:
        clipboard.request_text(_on_text_received)


def _is_wayland():
    if os.getenv("WAYLAND_DISPLAY") is not None:
        return True

    if os.getenv("XDG_SESSION_TYPE") == "wayland":
        return True

    return False


def _runner():
    try:
        if _is_wayland():
            _poll_clipboard()
            return

        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        from gi.repository import Gtk, Gdk

        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        clipboard.connect("owner-change", _on_clipboard_changed)
        Gtk.main()
    except Exception as e:
        logging.warning(f"Error with Gtk clipboard: {e}. Switching to polling mode.")
        _poll_clipboard()  # Start polling mode if Gtk clipboard fails


def _poll_clipboard():
    last_clipboard_text = None
    while True:
        current_text = _safe_paste()
        if current_text != last_clipboard_text:
            last_clipboard_text = current_text
            _callback_text(current_text)
        time.sleep(1)


def _safe_paste():
    global logged_once
    try:
        return pyperclip.paste()
    except Exception as e1:
        if not logged_once:
            logged_once = True
            logging.warning(
                f"Failed to paste from clipboard using pyperclip: {e1}. Switching to xclip."
            )

        # Fallback to xclip
        try:
            process = subprocess.Popen(
                ["xclip", "-selection", "clipboard", "-o"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            output, error = process.communicate()
            if process.returncode == 0:  # Success
                return output.decode()
            else:
                logging.error(f"xclip failed to paste: {error.decode()}")
        except Exception as e2:
            logging.error(f"Failed to paste from clipboard using xclip: {e2}")


def _start():
    global _clipboard_thread
    if not _clipboard_thread:
        _clipboard_thread = threading.Thread(target=_runner, daemon=True)
        _clipboard_thread.start()


def on_text(callback):
    global _callback_text
    _callback_text = callback
    _start()
