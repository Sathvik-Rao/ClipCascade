from io import BytesIO
import logging
import threading
import time
import pasteboard

_clipboard_thread = None
_callback_update = None
_run = False
_first_run = False
_block_image_once = False


def _runner(enable_image_monitoring=False, enable_file_monitoring=False):
    global _first_run, _block_image_once
    try:
        pb_text = pasteboard.Pasteboard()
        if enable_image_monitoring:
            pb_image_png = pasteboard.Pasteboard()
            pb_image_tiff = pasteboard.Pasteboard()
        if enable_file_monitoring:
            pb_files = pasteboard.Pasteboard()
        image_processed = False
        files_processed = False
        while _run:
            # don't change the execution order (files,text,image or files,image,text)

            if enable_file_monitoring:
                # Files
                clipboard_files = pb_files.get_file_urls(diff=True)
                if (
                    clipboard_files is not None
                    and type(clipboard_files) is tuple
                    and len(clipboard_files) > 0
                ):
                    if _callback_update and not _first_run:
                        files_processed = True
                        _callback_update("files", clipboard_files)

            # Text
            clipboard_text = pb_text.get_contents(
                type=pasteboard.String, diff=True
            )  # If True, retrieves and returns the content only if it has changed since the last call.
            # This approach is efficient even in cases of frequent polling.
            if (
                clipboard_text is not None
                and type(clipboard_text) is str
                and len(clipboard_text) > 0
            ):
                if _callback_update and not _first_run and not files_processed:
                    _callback_update("text", clipboard_text)

            if enable_image_monitoring:
                # Image (PNG)
                clipboard_image_png = pb_image_png.get_contents(
                    type=pasteboard.PNG, diff=True
                )
                if (
                    clipboard_image_png is not None
                    and type(clipboard_image_png) is bytes
                ):
                    if _callback_update and not _first_run and not image_processed:
                        image_processed = True
                        if _block_image_once:
                            _block_image_once = False
                        else:
                            if not files_processed:
                                _callback_update("image", clipboard_image_png)

                # Image (TIFF)
                clipboard_image_tiff = pb_image_tiff.get_contents(
                    type=pasteboard.TIFF, diff=True
                )
                if (
                    clipboard_image_tiff is not None
                    and type(clipboard_image_tiff) is bytes
                ):
                    if _callback_update and not _first_run and not image_processed:
                        image_processed = True
                        if _block_image_once:
                            _block_image_once = False
                        else:
                            if not files_processed:
                                _callback_update("image", clipboard_image_tiff)

            files_processed = False
            image_processed = False
            _first_run = False
            time.sleep(0.3)  # seconds

    except Exception as e:
        logging.error(f"Error processing clipboard update: {e}")


def _start(enable_image_monitoring=False, enable_file_monitoring=False):
    global _clipboard_thread, _run, _first_run
    if not _clipboard_thread:
        _run = True
        _first_run = True
        _clipboard_thread = threading.Thread(
            target=_runner,
            args=(enable_image_monitoring, enable_file_monitoring),
            daemon=True,
        )
        _clipboard_thread.start()


def stop():
    global _clipboard_thread, _callback_update, _run, _first_run, _block_image_once
    if _clipboard_thread:
        _run = False
        _clipboard_thread.join()  # Wait for the thread to finish
        _first_run = False
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
