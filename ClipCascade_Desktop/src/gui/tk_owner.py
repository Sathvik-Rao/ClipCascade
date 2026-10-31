"""Keep GUI windows on one long-lived, main-thread Tcl interpreter."""

import threading
import tkinter as tk

_gui_root = None


class _GuiRoot(tk.Tk):
    _callback_interrupt = None

    def report_callback_exception(self, exc, value, traceback):
        if not issubclass(exc, KeyboardInterrupt):
            return super().report_callback_exception(exc, value, traceback)
        # Tk catches callback exceptions, including Ctrl+C in native dialogs.
        # Unwind all window waits and re-raise outside Tcl so run() can clean up.
        self._callback_interrupt = value
        for child in list(self.winfo_children()):
            child.destroy()

    def raise_callback_interrupt(self):
        interrupt = self._callback_interrupt
        if interrupt is not None:
            self._callback_interrupt = None
            raise interrupt


def get_gui_root():
    global _gui_root
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("Tk windows must be used on the main thread")
    if _gui_root is None:
        _gui_root = _GuiRoot()
        _gui_root.withdraw()
    return _gui_root


class GuiWindow(tk.Toplevel):
    def __init__(self):
        # Retain one interpreter for the application's lifetime. Destroyed
        # dialogs can contain Python cycles which a network/save worker
        # later collects; they must not own the last interpreter reference.
        super().__init__(master=get_gui_root())
        self._pending_after_ids = set()

    def after(self, ms, func=None, *args):
        if func is None:
            return super().after(ms)

        def run():
            self._pending_after_ids.discard(callback_id)
            return func(*args)

        callback_id = super().after(ms, run)
        self._pending_after_ids.add(callback_id)
        return callback_id

    def after_cancel(self, callback_id):
        super().after_cancel(callback_id)
        self._pending_after_ids.discard(callback_id)

    def destroy(self):
        # The shared interpreter survives this window. Remove timers before
        # Tk deletes their Python commands, including delayed focus callbacks.
        for callback_id in tuple(self._pending_after_ids):
            self.after_cancel(callback_id)
        super().destroy()

    def mainloop(self, n=0):
        # The hidden owner remains alive when this window is destroyed.
        # Wait for this window only, rather than the owner's whole loop.
        try:
            self.wait_window()
        finally:
            get_gui_root().raise_callback_interrupt()
