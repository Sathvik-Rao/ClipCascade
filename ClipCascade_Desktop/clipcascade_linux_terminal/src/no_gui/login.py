import getpass
import re


class LoginForm:
    def __init__(
        self,
        username,
        password,
        server_url,
        websocket_url,
        cipher_enabled,
        notification,
        on_login_callback=None,
    ):
        self.username = input(f"username [{username}]: ") or username
        self.password = getpass.getpass("password: ")
        self.server_url = input(f"server url [{server_url}]: ") or server_url
        self.server_url = self.server_url.strip()
        self.server_url = re.sub(r"/+$", "", self.server_url)
        self.websocket_url = (
            input(f"websocket url [{websocket_url}]: ") or websocket_url
        )
        self.websocket_url = self.websocket_url.strip()
        self.websocket_url = re.sub(r"/+$", "", self.websocket_url)
        self.cipher_enabled = self.str_to_bool(
            input(f"cipher enabled [{self.bool_to_str(cipher_enabled)}]: ")
            or self.bool_to_str(cipher_enabled)
        )
        self.notification = self.str_to_bool(
            input(
                f"WebSocket connection notification [{self.bool_to_str(notification)}]: "
            )
            or self.bool_to_str(notification)
        )

        if on_login_callback:
            on_login_callback(
                self.username,
                self.password,
                self.server_url,
                self.websocket_url,
                self.cipher_enabled,
                self.notification,
            )

    def bool_to_str(self, value):
        return "y" if value else "n"

    def str_to_bool(self, value):
        return value.lower() == "y"
