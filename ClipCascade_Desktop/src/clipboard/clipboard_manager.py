import base64
import io
import json
import logging
import os
from contextlib import contextmanager
import xxhash


from PIL import Image
from clipboard.file_utils import encode_files, local_file_paths
from clipboard.update_worker import ClipboardUpdateWorker, ClipboardSuperseded
from core.constants import *
from core.config import Config
from utils.notification_manager import NotificationManager
from utils.transfer_limits import content_size
from utils import binary_protocol as binary

if PLATFORM.startswith(LINUX) and LINUX_USE_CLI_UI:
    from cli.tray import TaskbarPanel
else:
    from gui.tray import TaskbarPanel

if PLATFORM == WINDOWS or PLATFORM == MACOS:
    import pyperclip


if PLATFORM == WINDOWS:
    import win32clipboard
    from clipboard import clipboard_monitor_win as clipboard_monitor
elif PLATFORM == MACOS:
    import pasteboard
    from clipboard import clipboard_monitor_mac as clipboard_monitor
elif PLATFORM.startswith(LINUX):
    from clipboard import clipboard_monitor_linux as clipboard_monitor
    import subprocess


class ClipboardManager:
    def __init__(self, config: Config):
        self.config = config
        self.notification_manager = NotificationManager(config)
        self.previous_clipboard_hash = 0
        self.sys_tray: TaskbarPanel = None
        self.is_files_download_enabled = False
        self._update_worker = None
        self._remote_text = None
        self._can_send_content = None
        self._attachment_loading = None

        if PLATFORM.startswith(LINUX) and XMODE:
            self.is_x_clipboard_owner = clipboard_monitor.is_x_clipboard_owner()

    def set_tray_ref(self, sys_tray: TaskbarPanel):
        """
        Sets the system tray reference.
        """
        self.sys_tray = sys_tray

    def reset_files_download(self):
        """
        Clear pending files and any completed download status for the old clipboard item.
        """
        self.is_files_download_enabled = False
        if self.sys_tray:
            self.sys_tray.disable_files_download()

    @staticmethod
    def hash_clipboard(clipboard, kind="text") -> int:
        header, parts = binary.content_parts(clipboard, kind)
        digest = xxhash.xxh64()
        digest.update(json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        for part in parts:
            for offset in range(0, len(part), 1024 * 1024):
                digest.update(memoryview(part)[offset:offset + 1024 * 1024])
        return digest.intdigest()

    def is_clipboard_size_within_limit(
        self, clipboard_content: any, type_: str = "text"
    ) -> bool:
        if clipboard_content is None:
            raise ValueError("Clipboard content cannot be None")

        content_size_in_bytes = None
        if type_ == "text":
            content_size_in_bytes = len(clipboard_content.encode("utf-8"))
        elif type_ == "image":
            content_size_in_bytes = ClipboardManager.get_image_size(
                img=clipboard_content
            )
        elif type_ == "files":
            content_size_in_bytes = ClipboardManager.calculate_cumulative_file_size(
                files=clipboard_content
            )

        return self.is_content_size_within_limit(content_size_in_bytes)

    def is_content_size_within_limit(self, content_size_in_bytes):
        # Check if the content size exceeds the server limit
        max_allowed_size = self.config.data["maxsize"]
        if (
            max_allowed_size is not None
            and max_allowed_size >= 0
            and content_size_in_bytes > max_allowed_size
        ):
            logging.warning(
                "Clipboard content size exceeds the maximum allowed limit. "
                f"Allowed: {max_allowed_size} bytes, Found: {content_size_in_bytes} bytes."
            )
            return False

        # Check if the content size exceeds the local limit
        local_clipboard_size_limit = self.config.data[
            "max_clipboard_size_local_limit_bytes"
        ]
        if local_clipboard_size_limit is not None and local_clipboard_size_limit >= 0:
            if content_size_in_bytes > local_clipboard_size_limit:
                logging.warning(
                    "Clipboard content size exceeds the local allowed limit. "
                    f"Allowed: {local_clipboard_size_limit} bytes, Found: {content_size_in_bytes} bytes."
                )
                return False

        return True

    def has_clipboard_changed(self, payload, kind="text") -> bool:
        """
        Check if the clipboard content has changed by comparing the current hash
        with the previous clipboard hash.

        Parameters:
        - payload: The current clipboard content.

        Returns:
        - True if the clipboard content has changed, False otherwise.
        """
        current_clipboard_hash = ClipboardManager.hash_clipboard(payload, kind)
        if current_clipboard_hash != self.previous_clipboard_hash:
            self.previous_clipboard_hash = current_clipboard_hash
            return True
        return False

    def on_copy(self, copy_callback, on_change=None, can_send_content=None):
        self._can_send_content = can_send_content
        if self._update_worker is not None:
            self._update_worker.stop()
        worker = ClipboardUpdateWorker(
            self.prepare_clipboard,
            lambda payload, kind, current, size: copy_callback(
                payload, kind, is_current=current, content_size_bytes=size),
        )
        self._update_worker = worker

        def enqueue(kind, content):
            if kind == "text" and content == self._remote_text:
                self._remote_text = None
                return  # An OS notification for our own received text write.
            self._remote_text = None
            worker.invalidate()
            if on_change:
                on_change()
            self.reset_files_download()
            if self.config.data.get("send_clipboard", True):
                worker.submit(kind, content)

        clipboard_monitor.on_update(
            callback=enqueue,
            enable_image_monitoring=self.config.data["enable_image_sharing"],
            enable_file_monitoring=self.config.data["enable_file_sharing"],
        )

    def get_loading_status(self):
        loading = self._attachment_loading
        if loading is not None:
            message, check_current = loading
            try:
                check_current()
                return message
            except ClipboardSuperseded:
                pass
        return None

    @contextmanager
    def _loading_attachment(self, message, check_current):
        check_current()
        loading = (message, check_current)
        self._attachment_loading = loading
        try:
            yield
        finally:
            if self._attachment_loading is loading:
                self._attachment_loading = None

    def prepare_clipboard(self, callback, content: any, type_: str = "text"):
        if not self.config.data.get("send_clipboard", True):
            return
        try:
            check_current = getattr(callback, "check_current", lambda: None)
            check_current()
            type_ = type_.lower()
            if type_ == "text":
                if self.is_clipboard_size_within_limit(content, type_):
                    callback(content, type_, content_size_bytes=content_size(content, type_))

            elif type_ == "image":
                if isinstance(content, list):
                    if content is None or len(content) == 0:
                        raise ValueError(
                            "Clipboard image content cannot be None or empty"
                        )

                    content = Image.open(content[0])
                with self._loading_attachment("Loading image…", check_current):
                    if isinstance(content, bytes):
                        raw = content
                    else:
                        with io.BytesIO() as output:
                            content.save(output, format=content.format or "PNG")
                            raw = output.getvalue()
                check_current()
                if self.is_content_size_within_limit(len(raw)):
                    callback(raw, type_, content_size_bytes=len(raw))

            elif type_ == "files":
                if PLATFORM.startswith(LINUX):
                    content = local_file_paths(content or [])

                if self.is_clipboard_size_within_limit(content, type_):
                    size = self.calculate_cumulative_file_size(content)
                    if self._can_send_content and not self._can_send_content(size):
                        logging.info("No connected peer accepts this file's content size")
                        return
                    with self._loading_attachment("Loading files…", check_current):
                        content_str, size = encode_files(content, check_current, with_size=True, raw=True)
                    check_current()
                    # Recheck actual bytes read in case a file grew during preparation.
                    if bool(content_str) and self.is_content_size_within_limit(size):
                        callback(content_str, type_, content_size_bytes=size)
        except ClipboardSuperseded:
            pass
        except Exception as e:
            logging.error(f"Failed to prepare clipboard data: {e}")

    def cancel_preparation(self):
        if self._update_worker is not None:
            self._update_worker.invalidate()

    def content_to_clipboard(self, content: str | bytes | dict, type_: str = "text", is_current=lambda: True):
        if not self.config.data.get("receive_clipboard", True):
            return
        try:
            if type_ == "text":
                txt = content
                if self.is_clipboard_size_within_limit(txt, type_):
                    if is_current() and self.paste(txt, type_):
                        self.notification_manager.notify_clipboard_received(txt, type_)
            elif type_ == "image":
                raw = binary.original_content(content, type_)
                img = Image.open(io.BytesIO(raw))
                img.load()
                if self.is_content_size_within_limit(len(raw)):
                    if is_current() and self.paste(img, type_):
                        self.notification_manager.notify_clipboard_received(img, type_)
            elif type_ == "files":
                file_objects = {name: io.BytesIO(value) for name, value in
                                binary.original_content(content, type_).items()}
                if self.is_clipboard_size_within_limit(file_objects, type_):
                    if is_current() and self.paste(file_objects, type_):
                        self.notification_manager.notify_clipboard_received(file_objects, type_)
        except Exception as e:
            logging.error(f"Failed to apply clipboard content: {e}")

    @staticmethod
    def execute_command(*args, input_data):
        """
        Execute a command with input data.

        Parameters:
        - *args: Positional arguments for the command.
        - input_data: Input data to be passed to the command.
        """
        if PLATFORM.startswith(LINUX):
            try:
                subprocess.run(
                    args,
                    input=input_data,
                    check=True,
                )
            except Exception as e:
                logging.error(f"Failed to execute command: {e}")
                raise

    def paste(self, payload: any, payload_type: str = "text") -> bool:
        """Apply received content, returning whether it was accepted locally."""
        if not self.config.data.get("receive_clipboard", True):
            return False
        try:
            if payload_type != "text":
                self._remote_text = None
            self.reset_files_download()

            if payload_type == "text":
                self._remote_text = payload
                if PLATFORM == MACOS:
                    clipboard_monitor.write_to_pasteboard(payload, pasteboard.String)
                elif PLATFORM == WINDOWS:
                    pyperclip.copy(payload)
                elif PLATFORM.startswith(LINUX):
                    if XMODE and self.is_x_clipboard_owner:
                        ClipboardManager.execute_command(
                            "xclip",
                            "-selection",
                            "clipboard",
                            input_data=payload.encode("utf-8"),
                        )
                    else:
                        ClipboardManager.execute_command(
                            "wl-copy",
                            input_data=payload.encode("utf-8"),
                        )

            elif payload_type == "image":
                if PLATFORM == WINDOWS:
                    # Save the image to a binary buffer in BMP format
                    with io.BytesIO() as output:
                        payload.convert("RGB").save(output, format="BMP")
                        bmp_data = output.getvalue()[14:]  # Skip BMP header (14 bytes)

                    win32clipboard.OpenClipboard()
                    win32clipboard.EmptyClipboard()
                    clipboard_monitor.enable_block_image_once()  # Block image copy to prevent deadlock
                    win32clipboard.SetClipboardData(win32clipboard.CF_DIB, bmp_data)
                    win32clipboard.CloseClipboard()
                elif PLATFORM == MACOS:
                    # Save the image to a binary buffer in TIFF format
                    with io.BytesIO() as output:
                        payload.convert("RGB").save(output, format="TIFF")
                        tiff_data = output.getvalue()

                    clipboard_monitor.write_to_pasteboard(tiff_data, pasteboard.TIFF)
                elif PLATFORM.startswith(LINUX):
                    # Save the image to a binary buffer in PNG format
                    with io.BytesIO() as output:
                        payload.convert("RGB").save(output, format="PNG")
                        png_data = output.getvalue()

                    clipboard_monitor.enable_block_image_once()  # Block image copy to prevent deadlock
                    if XMODE and self.is_x_clipboard_owner:
                        ClipboardManager.execute_command(
                            "xclip",
                            "-selection",
                            "clipboard",
                            "-t",
                            "image/png",
                            input_data=png_data,
                        )
                    else:
                        ClipboardManager.execute_command(
                            "wl-copy",
                            "--type",
                            "image/png",
                            input_data=png_data,
                        )

            elif payload_type == "files":
                if (
                    payload is not None
                    and isinstance(payload, dict)
                    and len(payload) > 0
                ):
                    if self.sys_tray is not None:
                        self.is_files_download_enabled = True
                        self.sys_tray.enable_files_download(files=payload)
                        return True
                return False
            else:
                return False

            return True

        except Exception as e:
            logging.error(f"Failed to copy data to clipboard: {e}")
            raise

    def stop(self):
        if self._update_worker is not None:
            self._update_worker.stop()
            self._update_worker = None
        self.reset_files_download()
        clipboard_monitor.stop()

    @staticmethod
    def calculate_cumulative_file_size(files: tuple | list | dict) -> int:
        """
        Calculate the cumulative size of a list of files.

        Args:
            files (tuple or list): A tuple of file paths.
            files (dict): A dictionary of files with file names as keys and file object as values.

        Returns:
            int: The cumulative size of the files in bytes.

        Raises:
            IOError: If a file cannot be read or processed.
        """
        cumulative_size = 0
        if isinstance(files, tuple | list):
            for file_path in files:
                try:
                    if os.path.isfile(file_path):
                        cumulative_size += os.path.getsize(file_path)
                except Exception as e:
                    raise IOError(
                        f"Failed to calculate size for file '{file_path}' {e}."
                    ) from e

        if isinstance(files, dict):
            for file_name, file_object in files.items():
                try:
                    cumulative_size += file_object.getbuffer().nbytes
                except Exception as e:
                    raise IOError(
                        f"Failed to calculate size for file '{file_name}' {e}."
                    ) from e

        return cumulative_size

    @staticmethod
    def convert_files_to_base64(file_paths: tuple | list) -> str:
        """
        Converts a list of files to base64-encoded strings and returns them as a JSON string.

        Args:
            file_paths (tuple or list): A tuple of file paths to be converted.

        Returns:
            str: A JSON string where file names are keys and base64-encoded content is values.

        Raises:
            IOError: If a file cannot be read or processed.
        """
        return encode_files(file_paths)

    @staticmethod
    def convert_base64_to_files(base64_json: dict) -> dict:
        """
        Converts a JSON string with base64-encoded file content to a dictionary of file-like objects.

        Args:
            base64_json (str): A JSON string where file names are keys and base64-encoded content is values.

        Returns:
            dict: A dictionary where keys are file names, and values are BytesIO objects containing the decoded file data.
        """
        file_objects = {}
        try:
            base64_data = json.loads(base64_json)
            for file_name, encoded_content in base64_data.items():
                decoded_content = base64.b64decode(encoded_content)
                file_objects[file_name] = io.BytesIO(decoded_content)
        except Exception as e:
            raise IOError(f"Error processing base64 JSON. {e}") from e

        return file_objects

    @staticmethod
    def get_image_size(img: Image.Image | bytes) -> int:
        """
        Calculate the size of an image in bytes.

        Args:
            img (Image.Image | bytes): The image to calculate the size for.

        Returns:
            int: The size of the image in bytes.

        Raises:
            IOError: If the image cannot be processed or saved.
        """
        try:
            if isinstance(img, bytes):
                size_in_bytes = len(img)
            if isinstance(img, Image.Image):
                with io.BytesIO() as buffer:
                    img.save(buffer, format=img.format or "PNG")
                    size_in_bytes = buffer.tell()

            return size_in_bytes
        except Exception as e:
            raise IOError(f"Failed to calculate the image size. {e}") from e

    @staticmethod
    def convert_image_to_base64(img: Image.Image | bytes) -> str:
        """
        Converts an image to a base64-encoded string.

        Args:
            img (Image.Image | bytes): The image to be converted.

        Returns:
            str: The base64-encoded string representation of the image.

        Raises:
            IOError: If the image cannot be processed or saved.
        """
        try:
            if isinstance(img, bytes):
                base64_string = base64.b64encode(img).decode("utf-8")
            if isinstance(img, Image.Image):
                with io.BytesIO() as buffered:
                    img.save(buffered, format=img.format or "PNG")
                    base64_string = base64.b64encode(buffered.getvalue()).decode(
                        "utf-8"
                    )

            return base64_string
        except Exception as e:
            raise IOError(f"Failed to convert the image to base64. {e}") from e

    @staticmethod
    def convert_base64_to_image(base64_img: str) -> Image.Image:
        """
        Converts a base64-encoded string to a PIL Image object.

        Args:
            base64_img (str): The base64-encoded string to be converted.

        Returns:
            Image.Image: A PIL Image object representing the decoded image.

        Raises:
            ValueError: If the base64 string is invalid.
            IOError: If the image cannot be processed.
        """
        try:
            # Decode the base64 string
            image_data = base64.b64decode(base64_img)
        except base64.binascii.Error as e:
            raise ValueError("Invalid base64 string.") from e

        try:
            # Load the image from the decoded bytes
            with io.BytesIO(image_data) as image_stream:
                image = Image.open(image_stream)
                image.load()
            return image
        except IOError as e:
            raise IOError(f"Failed to process the image. {e}") from e
