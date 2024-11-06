import threading
import pasteboard
import time

_callback_text = None
_clipboard_thread = None


def _runner():
    global _callback_text
    pb = pasteboard.Pasteboard()
    while True:
        clipboard = pb.get_contents(
            diff=True
        )  # If True, retrieves and returns the content only if it has changed since the last call.
        # This approach is efficient even in cases of frequent polling.

        if clipboard is not None and type(clipboard) is str and len(clipboard) > 0:
            if _callback_text:
                _callback_text(clipboard)
        time.sleep(0.3)


def _start():
    global _clipboard_thread
    if not _clipboard_thread:
        _clipboard_thread = threading.Thread(target=_runner, daemon=True)
        _clipboard_thread.start()


def on_text(callback):
    global _callback_text
    _callback_text = callback
    _start()
