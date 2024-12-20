import logging
import requests
from core.constants import *
from core.config import Config


class RequestManager:
    def __init__(self, config: Config):
        self.config = config

    @staticmethod
    def format_cookie(cookie: dict) -> str:
        """
        Format the cookie string for headers.
        """
        return f"JSESSIONID={cookie.get('JSESSIONID', '')};"

    def login(self) -> tuple[bool, str, dict]:
        try:
            session = requests.Session()
            form_data = {
                "username": self.config.data["username"],
                "password": self.config.data["password"],
                "remember-me": "on",
            }
            response = session.post(
                self.config.data["server_url"] + self.config.data["login_url"],
                data=form_data,
            )
            if (
                response.status_code == 200
                and "bad credentials" not in response.text.lower()
            ):
                # login successful
                cookie = session.cookies.get_dict()
                logging.info(f"Login successful: {response.status_code}")
                return True, "Login successful", cookie
            else:
                # login failed
                msg = f"Login failed: {response.status_code}"
                logging.error(msg)
                return False, msg, None
        except Exception as e:
            msg = f"An error occurred during login: {e}"
            logging.error(msg)
            return False, msg, None

    def maxsize(self) -> int:
        try:
            response = RequestManager.get(
                url=self.config.data["server_url"] + self.config.data["maxsize_url"],
                headers={
                    "Cookie": RequestManager.format_cookie(self.config.data["cookie"])
                },
            )
            if response.status_code == 200:
                # maxsize request successful
                maxsize = response.json().get("maxsize", MAX_SIZE)
                logging.info(f"Max size: {maxsize}")
                return maxsize
        except Exception as e:
            logging.error(
                f"Error fetching max size: {e}, defaulting to {MAX_SIZE} Bytes"
            )
        return MAX_SIZE

    def logout(self):
        try:
            response = RequestManager.get(
                url=self.config.data["server_url"] + self.config.data["logout_url"],
                headers={
                    "Cookie": RequestManager.format_cookie(self.config.data["cookie"])
                },
            )
            if response.status_code == 200:
                logging.info(f"Logout successful: {response.status_code}")
        except Exception as e:
            logging.error(f"Error during logout: {e}")

    @staticmethod
    def get(url: str, headers: dict = None) -> requests.Response:
        """
        A generic GET mapper for handling GET requests.
        """
        try:
            response = requests.get(url, headers=headers)
            response.raise_for_status()  # Will raise an HTTPError if the HTTP request returned an unsuccessful status code
            return response
        except Exception as e:
            logging.error(f"Error during GET request to {url}: {e}")
            raise
