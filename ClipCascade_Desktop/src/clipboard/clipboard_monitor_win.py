import logging
import win32gui
import win32api
import win32con
import win32clipboard
import threading
import ctypes
import time
from PIL import ImageGrab


_clipboard_thread = None
_hwnd = None  # Store the window handle
_callback_update = None
_block_image_once = False


def _get_clipboard_content(enable_image_monitoring=False, enable_file_monitoring=False):
    """
    Get the content of the clipboard.

    Image:
        PNG -> PngImagePlugin.PngImageFile
        DIB -> BmpImagePlugin.DibImageFile
        PNG, DIB, JPG, etc. -> [file_path1, file_path2, ...]

    Text:
        CF_UNICODETEXT, CF_TEXT -> str

    Files:
        CF_HDROP -> (file_path1, file_path2, ...)
    """
    # sleep 0.5 to avoid clipboard not ready for read
    time.sleep(0.5)
    clipboard_type = None
    clipboard_content = None

    if enable_image_monitoring and win32clipboard.IsClipboardFormatAvailable(
        win32con.CF_BITMAP
    ):
        clipboard_type = "image"
        clipboard_content = ImageGrab.grabclipboard()
    else:
        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                text = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
                clipboard_type = "text"
                clipboard_content = text
            elif win32clipboard.IsClipboardFormatAvailable(win32con.CF_TEXT):
                text_bytes = win32clipboard.GetClipboardData(win32con.CF_TEXT)
                text = text_bytes.decode()
                clipboard_type = "text"
                clipboard_content = text
            elif enable_file_monitoring and win32clipboard.IsClipboardFormatAvailable(
                win32con.CF_HDROP
            ):
                files = win32clipboard.GetClipboardData(win32con.CF_HDROP)
                clipboard_type = "files"
                clipboard_content = files
        finally:
            win32clipboard.CloseClipboard()

    return (clipboard_type, clipboard_content)


def _process_message(
    hwnd: int,
    msg: int,
    wparam: int,
    lparam: int,
    enable_image_monitoring=False,
    enable_file_monitoring=False,
):
    global _block_image_once
    WM_CLIPBOARDUPDATE = 0x031D
    if msg == WM_CLIPBOARDUPDATE:
        clip = _get_clipboard_content(enable_image_monitoring, enable_file_monitoring)

        try:
            if clip[0] == "text" and _callback_update:
                _callback_update(clip[0], clip[1])

            if enable_image_monitoring and clip[0] == "image" and _callback_update:
                if _block_image_once:
                    _block_image_once = False
                else:
                    _callback_update(clip[0], clip[1])

            if enable_file_monitoring and clip[0] == "files" and _callback_update:
                _callback_update(clip[0], clip[1])
        except Exception as e:
            logging.error(f"Error processing clipboard update: {e}")
    return 0


def _create_window(enable_image_monitoring=False, enable_file_monitoring=False):
    global _hwnd
    className = "ClipboardHook"
    wc = win32gui.WNDCLASS()
    wc.lpfnWndProc = lambda hwnd, msg, wparam, lparam: _process_message(
        hwnd, msg, wparam, lparam, enable_image_monitoring, enable_file_monitoring
    )
    wc.lpszClassName = className
    wc.hInstance = win32api.GetModuleHandle(None)
    class_atom = win32gui.RegisterClass(wc)
    _hwnd = win32gui.CreateWindow(
        class_atom, className, 0, 0, 0, 0, 0, 0, 0, wc.hInstance, None
    )


def _runner(enable_image_monitoring=False, enable_file_monitoring=False):
    global _hwnd
    _create_window(enable_image_monitoring, enable_file_monitoring)
    ctypes.windll.user32.AddClipboardFormatListener(_hwnd)
    try:
        win32gui.PumpMessages()
    finally:
        ctypes.windll.user32.RemoveClipboardFormatListener(_hwnd)
        win32gui.DestroyWindow(_hwnd)
        win32gui.UnregisterClass("ClipboardHook", win32api.GetModuleHandle(None))


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
    global _clipboard_thread, _hwnd, _callback_update, _block_image_once
    if _clipboard_thread and _hwnd:
        win32gui.PostMessage(
            _hwnd, win32con.WM_QUIT, 0, 0
        )  # Send WM_QUIT to the window
        _clipboard_thread.join()  # Wait for the thread to finish
        _clipboard_thread = None
        _hwnd = None
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
