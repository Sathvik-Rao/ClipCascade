import base64
import json
import os
import re
from core.constants import *


class Config:
    def __init__(self, file_name=DATA_FILE_NAME):
        self.file_name = file_name
        self.data = {
            "cipher_enabled": True,
            "server_url": "http://localhost:8080",
            "websocket_url": "",
            "username": "",
            "hashed_password": None,
            "cookie": None,
            "maxsize": None,
            "hash_rounds": 664937,
            "salt": "",
            "csrf_token": "",
            "notification": True,
            "save_password": False,
            "password": "",
            "max_clipboard_size_local_limit_bytes": None,
            "enable_image_sharing": True,
            "enable_file_sharing": True,
            "default_file_download_location": "",
            "server_mode": "P2S",
            "stun_url": "",
        }

    def save(self):
        """
        Save data to file
        """
        try:
            temp = self.data.copy()
            if self.data.get("cipher_enabled") and self.data.get("hashed_password"):
                temp["hashed_password"] = base64.b64encode(
                    temp["hashed_password"]
                ).decode("utf-8")
            with open(self.file_name, "w") as f:
                json.dump(temp, f, indent=4)
        except Exception as e:
            logging.error(f"Failed to save data: {e}")

    def load(self):
        """
        Load data from file
        """
        if os.path.isfile(self.file_name):
            try:
                with open(self.file_name, "r") as f:
                    file_data = json.load(f)
                    self.data.update(file_data)
                # Decode hashed_password if present
                if self.data.get("hashed_password"):
                    self.data["hashed_password"] = base64.b64decode(
                        self.data["hashed_password"]
                    )
                return True
            except Exception as e:
                logging.error(f"Failed to load data: {e}")
                logging.error(
                    "Try deleting DATA file in the program directory, and re-run the program again"
                )
        return False

    @staticmethod
    def convert_to_websocket_url(input_url: str, endpoint: str = None) -> str:
        if not input_url or not isinstance(input_url, str):
            raise ValueError("Invalid URL provided")

        # Trim whitespace, remove trailing slashes, and convert to lowercase
        input_url = re.sub(r"/+$", "", input_url.strip()).lower()

        # Determine protocol and convert
        if input_url.startswith("https://"):
            ws_url = input_url.replace("https://", "wss://", 1)
        elif input_url.startswith("http://"):
            ws_url = input_url.replace("http://", "ws://", 1)
        else:
            raise ValueError(f"Unsupported protocol in URL: {input_url}")

        if endpoint is not None:
            # Append the WebSocket endpoint and remove any trailing slash
            ws_url += endpoint
            ws_url = re.sub(r"/+$", "", ws_url)

        return ws_url
