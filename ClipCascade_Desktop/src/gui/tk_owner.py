"""Keep GUI windows on one long-lived, main-thread Tcl interpreter."""

import threading
import tkinter as tk

_gui_root = None


def get_gui_root():
    global _gui_root
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError("Tk windows must be used on the main thread")
    if _gui_root is None:
        _gui_root = tk.Tk()
        _gui_root.withdraw()
    return _gui_root


class GuiWindow(tk.Toplevel):
    def __init__(self):
        # Retain one interpreter for the application's lifetime. Destroyed
        # dialogs can contain Python cycles which a network/save worker
        # later collects; they must not own the last interpreter reference.
        super().__init__(master=get_gui_root())

    def mainloop(self, n=0):
        # The hidden owner remains alive when this window is destroyed.
        # Wait for this window only, rather than the owner's whole loop.
        self.wait_window()
