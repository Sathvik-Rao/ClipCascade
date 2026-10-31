"""Dispatch AppKit operations without blocking a network worker or the main loop."""
from functools import wraps
import threading

from core.constants import MACOS, PLATFORM

if PLATFORM == MACOS:
    import objc
    from Foundation import NSObject, NSRunLoopCommonModes

    class MainThreadCall(NSObject):
        @objc.signature(b"v@:@")
        def invoke_(self, unused):
            self.callback()


def on_main_thread(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        if PLATFORM == MACOS and threading.current_thread() is not threading.main_thread():
            # AppHelper.callAfter uses the default run-loop mode, which pauses
            # while a tray menu is tracking. Common modes include menu tracking.
            call = MainThreadCall.alloc().init()
            call.callback = lambda: func(*args, **kwargs)
            call.performSelectorOnMainThread_withObject_waitUntilDone_modes_(
                b"invoke:", None, False, [NSRunLoopCommonModes]
            )
            return None
        return func(*args, **kwargs)
    return wrapped
