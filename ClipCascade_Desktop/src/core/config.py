import base64
import json
import os
from core.constants import *


class Config:
    def __init__(self, file_name=DATA_FILE_NAME):
        self.file_name = file_name
        self.data = {
            "cipher_enabled": True,
            "server_url": "http://localhost:8080",
            "websocket_url": "ws://localhost:8080/clipsocket",
            "username": "",
            "hashed_password": None,
            "cookie": None,
            "maxsize": None,
            "subscription_destination": "/topic/cliptext",
            "send_destination": "/app/cliptext",
            "hash_rounds": 664937,
            "login_url": "/login",
            "logout_url": "/logout",
            "maxsize_url": "/max-size",
            "salt": "",
            "notification": True,
            "save_password": False,
            "password": "",
            "max_clipboard_size_local_limit_bytes": None,
            "enable_image_sharing": True,
            "enable_file_sharing": True,
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
