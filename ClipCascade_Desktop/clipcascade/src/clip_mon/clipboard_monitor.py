import win32gui
import win32api
import win32con
import win32clipboard
import threading
import ctypes
import time


_callback_text = None
_callback_image = None
_callback_files = None
_callback_update = None
_clipboard_thread = None


def _get_clipboard_content():

    # sleep 0.5 to avoid clipboard not ready for read
    time.sleep(0.5)

    clipboard_type = None
    clipboard_content = None

    if win32clipboard.IsClipboardFormatAvailable(win32con.CF_BITMAP):
        clipboard_type = "image"
    else:
        win32clipboard.OpenClipboard()
        if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
            text = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
            clipboard_type = "text"
            clipboard_content = text
        elif win32clipboard.IsClipboardFormatAvailable(win32con.CF_TEXT):
            text_bytes = win32clipboard.GetClipboardData(win32con.CF_TEXT)
            text = text_bytes.decode()
            clipboard_type = "text"
            clipboard_content = text
        elif win32clipboard.IsClipboardFormatAvailable(win32con.CF_HDROP):
            files = win32clipboard.GetClipboardData(win32con.CF_HDROP)
            clipboard_type = "files"
            clipboard_content = files
        win32clipboard.CloseClipboard()

    return (clipboard_type, clipboard_content)


def _process_message(hwnd: int, msg: int, wparam: int, lparam: int):
    WM_CLIPBOARDUPDATE = 0x031D
    if msg == WM_CLIPBOARDUPDATE:
        clip = _get_clipboard_content()

        if clip[0] != None and _callback_update:
            _callback_update()

        if clip[0] == "text" and _callback_text:
            _callback_text(clip[1])

        if clip[0] == "image" and _callback_update:
            _callback_image()

        if clip[0] == "files" and _callback_files:
            _callback_files(clip[1])

    return 0


def _create_window():
    className = "ClipboardHook"
    wc = win32gui.WNDCLASS()
    wc.lpfnWndProc = _process_message
    wc.lpszClassName = className
    wc.hInstance = win32api.GetModuleHandle(None)
    class_atom = win32gui.RegisterClass(wc)
    return win32gui.CreateWindow(
        class_atom, className, 0, 0, 0, 0, 0, 0, 0, wc.hInstance, None
    )


def _runner():
    hwnd = _create_window()
    ctypes.windll.user32.AddClipboardFormatListener(hwnd)
    win32gui.PumpMessages()


def _start():
    global _clipboard_thread
    if not _clipboard_thread:
        _clipboard_thread = threading.Thread(target=_runner, daemon=True)
        _clipboard_thread.start()


def wait():
    global _clipboard_thread
    while _clipboard_thread.is_alive():
        _clipboard_thread.join(0.25)


def on_update(callback):
    global _callback_update
    _callback_update = callback
    _start()


def on_text(callback):
    global _callback_text
    _callback_text = callback
    _start()


def on_files(callback):
    global _callback_files
    _callback_files = callback
    _start()


def on_image(callback):
    global _callback_image
    _callback_image = callback
    _start()
