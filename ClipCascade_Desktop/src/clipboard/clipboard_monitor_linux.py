import logging
import re
import subprocess
import threading
import time

from core.constants import *

_callback_update = None
_clipboard_thread = None

_block_image_once = False

_is_gdk_running = False
_run_poll = threading.Event()


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
    previous_clipboard: str | bytes | None = None
    ignore_patterns = [
        r"target .+ not available",  # xclip pattern
        r"no suitable type of content copied",  # wl-clipboard pattern
    ]

    if x_mode:
        timeout = 0.3  # seconds
    else:
        timeout = 5  # seconds

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


def _start_clipboard_polling(enable_image_monitoring, enable_file_monitoring):
    if XMODE:
        _monitor_x_wl_clipboard(
            x_mode=True,
            enable_image_monitoring=enable_image_monitoring,
            enable_file_monitoring=enable_file_monitoring,
        )
    else:
        _monitor_x_wl_clipboard(
            x_mode=False,
            enable_image_monitoring=enable_image_monitoring,
            enable_file_monitoring=enable_file_monitoring,
        )


def _runner(enable_image_monitoring=False, enable_file_monitoring=False):
    global _is_gdk_running, _run_poll
    try:
        _run_poll.set()
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        from gi.repository import Gtk, Gdk

        if "x11" in str(type(Gdk.Display.get_default())).lower():  # X11
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
            _start_clipboard_polling(enable_image_monitoring, enable_file_monitoring)
    except Exception as e:
        logging.error(
            f"Failed to start clipboard monitor: Error {e}\nStarting polling mode for {detect_linux_display_server()} server as fallback"
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
    global _clipboard_thread, _callback_update, _block_image_once, _run_poll, _is_gdk_running
    if _clipboard_thread:
        if _is_gdk_running:
            import gi

            gi.require_version("Gtk", "3.0")
            from gi.repository import Gtk

            Gtk.main_quit()
            _is_gdk_running = False
        _run_poll.clear()
        _clipboard_thread.join()  # Wait for the thread to finish
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
