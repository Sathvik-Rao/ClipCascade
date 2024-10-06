import threading

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk

_callback_text = None
_clipboard_thread = None


def _on_text_received(clipboard, text):
    global _callback_text
    if text is not None:
        _callback_text(text)


def _on_clipboard_changed(clipboard, event=None):
    global _callback_text

    if _callback_text:
        clipboard.request_text(_on_text_received)


def _runner():
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    clipboard.connect("owner-change", _on_clipboard_changed)
    Gtk.main()


def _start():
    global _clipboard_thread
    if not _clipboard_thread:
        _clipboard_thread = threading.Thread(target=_runner, daemon=True)
        _clipboard_thread.start()


def on_text(callback):
    global _callback_text
    _callback_text = callback
    _start()
