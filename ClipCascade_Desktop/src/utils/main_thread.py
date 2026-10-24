"""Dispatch AppKit operations without blocking a network worker or the main loop."""
from functools import wraps
import threading

from core.constants import MACOS, PLATFORM

if PLATFORM == MACOS:
    from PyObjCTools import AppHelper


def on_main_thread(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        if PLATFORM == MACOS and threading.current_thread() is not threading.main_thread():
            AppHelper.callAfter(func, *args, **kwargs)
            return None
        return func(*args, **kwargs)
    return wrapped
