import json
import logging
import requests
from core.constants import *
from core.config import Config
from bs4 import BeautifulSoup


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

            # Fetch the login page to get the CSRF token
            response = session.get(self.config.data["server_url"] + LOGIN_URL)

            if response.status_code != 200:
                msg = f"Failed to fetch login page: {response.status_code}"
                logging.error(msg)
                return False, msg, None

            soup = BeautifulSoup(response.text, "html.parser")
            csrf_token = soup.find("input", {"name": "_csrf"})["value"]

            # Login with the credentials
            form_data = {
                "username": self.config.data["username"],
                "password": self.config.data["password"],
                "_csrf": csrf_token,
            }
            response = session.post(
                self.config.data["server_url"] + LOGIN_URL,
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
                url=self.config.data["server_url"] + MAXSIZE_URL,
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
            response = RequestManager.post(
                url=self.config.data["server_url"] + LOGOUT_URL,
                data={"_csrf": self.config.data["csrf_token"]},
                headers={
                    "Cookie": RequestManager.format_cookie(self.config.data["cookie"])
                },
            )
            if response.status_code == 204:
                logging.info(f"Logout successful: {response.status_code}")
        except Exception as e:
            logging.error(f"Error during logout: {e}")

    def get_csrf_token(self) -> str:
        try:
            response = RequestManager.get(
                url=self.config.data["server_url"] + CSRF_URL,
                headers={
                    "Cookie": RequestManager.format_cookie(self.config.data["cookie"])
                },
            )

            if response.status_code == 200:
                # CSRF token request successful
                return json.loads(response.text).get("token", "")
        except Exception as e:
            logging.error(f"Error fetching CSRF token: {e}")
            return ""

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

    @staticmethod
    def post(url: str, data: dict, headers: dict = None) -> requests.Response:
        """
        A generic POST mapper for handling POST requests.
        """
        try:
            response = requests.post(url, data=data, headers=headers)
            response.raise_for_status()  # Will raise an HTTPError if the HTTP request returned an unsuccessful status code
            return response
        except Exception as e:
            logging.error(f"Error during POST request to {url}: {e}")
            raise
