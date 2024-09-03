import base64
import gc
import json
import logging
import hashlib
import sys
import ctypes
import threading
import time
import pyperclip
import requests
import os

from stomp_ws.client import Client
from clip_mon import clipboard_monitor
from Crypto.Cipher import AES
from gui.login import LoginForm
from gui.info import CustomDialog
from gui.tray import TaskbarPanel

# When creating the executable with pyinstaller, add --hidden-import plyer.platforms.win.notification
from plyer import notification

client = None

toggle = False
connection_lost = False
startup_login_execution = True
first_connection_lost_notification = True
kill_re_connect_thread = False

event_reconnect = threading.Event()
event_reconnect.clear()

RE_CONNECT_RETRY_EVENT_TIMER = 10  # seconds
WEBSOCKET_TIMEOUT = 3000  # milliseconds


def login(
    username: str, password: str, login_url: str, maxsize_url: str
) -> tuple[bool, str, dict[str, str], int]:
    try:
        form_data = {"username": username, "password": password, "remember-me": "on"}
        session = requests.Session()
        response = session.post(login_url, data=form_data)
        if (
            response.status_code == 200
            and "bad credentials" not in response.text.lower()
        ):
            cookie = session.cookies.get_dict()
            logging.info(f"Login successful: {response.status_code}")
            # get maxsize limit
            response_maxsize = requests.get(
                maxsize_url, headers={"Cookie": f"JSESSIONID={cookie['JSESSIONID']};"}
            )
            if response_maxsize.status_code == 200:
                maxsize = response_maxsize.json().get("maxsize")
                logging.info(f"Max size: {maxsize}")
            else:
                maxsize = 1048576
                logging.error(
                    f"Failed to get max size: {response_maxsize.status_code}, defaulting to {maxsize} MiB"
                )
            return True, "Login successful", cookie, maxsize
        else:
            msg = f"Login failed: {response.status_code}"
            logging.error(msg)
            return False, msg, None, None
    except Exception as e:
        msg = f"An error occurred during login: {e}"
        logging.error(msg)
        return False, msg, None, None


def stomp_closed():
    global connection_lost
    global startup_login_execution
    global first_connection_lost_notification
    if not startup_login_execution:
        connection_lost = True
        if first_connection_lost_notification:
            notification.notify(
                title="ClipCascade: WebSocket Connection Lost ⛓️‍💥",
                message="Check your internet connection. Retrying...",
                app_name="ClipCascade",
                timeout=10,  # seconds
            )
            first_connection_lost_notification = False
        event_reconnect_release()


def event_reconnect_relock():
    global event_reconnect
    event_reconnect.clear()


def event_reconnect_release():
    global event_reconnect
    event_reconnect.set()


def kill_re_connect_thread_event_trigger_thread():
    global kill_re_connect_thread
    kill_re_connect_thread = True
    event_reconnect_release()


def re_connect_retry_event_trigger(
    websocket_url, cookie, subscription_destination, cipher_enabled, hashed_password
):
    global event_reconnect
    global RE_CONNECT_RETRY_EVENT_TIMER
    global kill_re_connect_thread
    while not kill_re_connect_thread:
        event_reconnect.wait()  # Block the thread until released
        if not kill_re_connect_thread:
            try:
                re_connect(
                    websocket_url,
                    cookie,
                    subscription_destination,
                    cipher_enabled,
                    hashed_password,
                )
                event_reconnect_relock()
            except Exception as e:
                time.sleep(RE_CONNECT_RETRY_EVENT_TIMER)


def stomp_connect(
    websocket_url: str,
    cookie: dict,
) -> tuple[bool, str, Client]:
    global WEBSOCKET_TIMEOUT
    try:
        client = Client(
            websocket_url,
            headers=cookie,
            on_close_callback=stomp_closed,
        )
        client.connect(timeout=WEBSOCKET_TIMEOUT)
        logging.info("Websocket connected")
        return True, "Websocket connected", client
    except Exception as e:
        msg = f"Failed to connect websocket: {e}"
        logging.error(msg)
        return False, msg, None


def stomp_send(
    text: str,
    send_destination: str,
    maxsize: int,
    cipher_enabled: bool = False,
    key: bytes = None,
):
    global client
    global toggle
    global connection_lost
    try:
        if toggle:
            toggle = False
            return
        if client is not None:
            if connection_lost:
                client = None
                notification.notify(
                    title="ClipCascade: WebSocket Connection Lost ⛓️‍💥",
                    message="Check your internet connection. Retrying...",
                    app_name="ClipCascade",
                    timeout=10,  # seconds
                )
                return
            text_size_in_bytes = len(text.encode("utf-8"))
            if text_size_in_bytes > maxsize:
                # clipboard max size exceeded
                logging.warning(
                    f"Max size({maxsize}) exceeded(>=): Clipboard size ({text_size_in_bytes})"
                )
                return
            if cipher_enabled:
                text = convert_to_json_string(*encrypt(text, key))
            toggle = True
            client.send(send_destination, body=json.dumps({"text": text}))
    except Exception as e:
        msg = f"Failed to send clipboard data: {e}"
        logging.error(msg)
        CustomDialog(msg, msg_type="error").mainloop()
        toggle = False


def stomp_receive(frame: any, cipher_enabled: bool = False, key: bytes = None):
    global toggle
    try:
        if toggle:
            toggle = False
            return
        text = json.loads(frame.body)["text"]
        if cipher_enabled:
            text = decrypt(**convert_from_json_string(text), key=key)
        toggle = True
        pyperclip.copy(text)
    except Exception as e:
        logging.error(f"Failed to process received clipboard data: {e}")
        logging.error(
            "If cipher is enabled, please make sure it is enables on all devices"
        )
        toggle = False


def hash(password: str, salt: bytes, rounds: int) -> bytes:
    return hashlib.pbkdf2_hmac(
        hash_name="sha256",
        password=password.encode(),
        salt=salt,
        iterations=rounds,
        dklen=32,  # 256 bits for AES-256
    )


def encrypt(plaintext: str, key: bytes) -> tuple[bytes, bytes, bytes]:
    plaintext_bytes = plaintext.encode("utf-8")
    cipher = AES.new(key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext_bytes)
    return cipher.nonce, ciphertext, tag


def decrypt(nonce: bytes, ciphertext: bytes, tag: bytes, key: bytes) -> str:
    cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
    return cipher.decrypt_and_verify(ciphertext, tag).decode()


def convert_to_json_string(nonce: bytes, ciphertext: bytes, tag: bytes) -> str:
    # Encode binary data to Base64
    json_data = {
        "nonce": base64.b64encode(nonce).decode("utf-8"),
        "ciphertext": base64.b64encode(ciphertext).decode("utf-8"),
        "tag": base64.b64encode(tag).decode("utf-8"),
    }
    # Convert the dictionary to a JSON string
    json_string = json.dumps(json_data)
    return json_string


def convert_from_json_string(json_string: str) -> dict[str, bytes]:
    json_data = json.loads(json_string)
    data_dict = {}
    for key, value in json_data.items():
        # Decode Base64 encoded values
        data_dict[key] = base64.b64decode(value)
    return data_dict


def disconnect_client():
    global client
    global connection_lost
    global first_connection_lost_notification
    event_reconnect_relock()
    first_connection_lost_notification = True
    if client is not None:
        if not connection_lost:
            client.disconnect()
        client = None
    connection_lost = True


def re_connect(
    websocket_url: str,
    cookie: str,
    subscription_destination: str,
    cipher_enabled: bool,
    hashed_password: bytes,
):
    global client
    global connection_lost
    global first_connection_lost_notification
    ws_conn_successful, msg, client_temp = stomp_connect(
        websocket_url,
        {"Cookie": cookie},
    )
    if not ws_conn_successful:
        raise Exception("Failed to connect to websocket")
    connection_lost = False
    client = client_temp
    subscribe_ws(client, subscription_destination, cipher_enabled, hashed_password)
    if not first_connection_lost_notification:
        notification.notify(
            title="ClipCascade: WebSocket Connection Restored 🔗",
            message="Connection re-established",
            app_name="ClipCascade",
            timeout=5,  # seconds
        )
        first_connection_lost_notification = True


def logoff_and_exit(client: Client, data: dict, DATA_fILE_NAME: str):
    disconnect_client()
    try:
        data["hashed_password"] = None
        data["cookie"] = None
        data["maxsize"] = None
        with open(DATA_fILE_NAME, "w") as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        raise Exception(f"Failed to clear data: {e}")


def subscribe_ws(
    client: Client,
    subscription_destination: str,
    cipher_enabled: bool,
    hashed_password: bytes,
):
    try:
        client.subscribe(
            subscription_destination,
            callback=lambda frame: stomp_receive(
                frame, cipher_enabled, hashed_password
            ),
        )
    except Exception as e:
        logging.error(f"An error occurred while subscribing: {e}")
        raise


if __name__ == "__main__":
    try:
        mutex_name = "Global\\ClipCascade_Mutex_PSSR"
        mutex = ctypes.windll.kernel32.CreateMutexW(None, False, mutex_name)
        if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            CustomDialog(
                "Another instance of ClipCascade is already running.",
                msg_type="error",
                timeout=3000,
            ).mainloop()
            sys.exit(0)

        data = {
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
        }

        LOG_FILE_NAME = "clipcascade_log.log"
        DATA_fILE_NAME = "DATA"

        # Enable logging
        LOG_FORMAT = "%(asctime)s - %(levelname)s - %(message)s"
        logging.basicConfig(
            level=logging.INFO,  # INFO
            format=LOG_FORMAT,
            filename=LOG_FILE_NAME,
            filemode="w",
        )

        login_window_enable = True
        if os.path.isfile(DATA_fILE_NAME):
            try:
                login_window_enable = False
                # Load data
                with open(DATA_fILE_NAME, "r") as f:
                    data = json.load(f)
                    if data["hashed_password"] is not None:
                        data["hashed_password"] = base64.b64decode(
                            data["hashed_password"]
                        )
                    if data["cookie"] is not None:
                        ws_conn_successful, msg, client = stomp_connect(
                            data["websocket_url"],
                            {"Cookie": f"JSESSIONID={data['cookie']['JSESSIONID']};"},
                        )
                        if not ws_conn_successful:
                            login_window_enable = True
                        else:
                            startup_login_execution = False
                    else:
                        login_window_enable = True
            except Exception as e:
                logging.error(f"Failed to load data: {e}")
                logging.error(
                    "Try deleting DATA file in the program directory, and re-run the program again"
                )
                login_window_enable = True

        if login_window_enable:
            while True:
                login_form = LoginForm(
                    data["username"],
                    data.get("password", ""),
                    data["server_url"],
                    data["websocket_url"],
                    data["cipher_enabled"],
                    lambda username, password, server_url, websocket_url, cipher_enabled: (
                        data.update(
                            {
                                "username": username,
                                "password": password,
                                "server_url": server_url,
                                "websocket_url": websocket_url,
                                "cipher_enabled": cipher_enabled,
                            }
                        )
                    ),
                    lambda: sys.exit(0),
                )
                login_form.mainloop()  # wait until form is closed

                login_successful, msg, data["cookie"], data["maxsize"] = login(
                    data["username"],
                    data["password"],
                    data["server_url"] + data["login_url"],
                    data["server_url"] + data["maxsize_url"],
                )
                if login_successful:
                    ws_conn_successful, msg, client = stomp_connect(
                        data["websocket_url"],
                        {"Cookie": f"JSESSIONID={data['cookie']['JSESSIONID']};"},
                    )
                    if ws_conn_successful:
                        startup_login_execution = False
                        threading.Thread(
                            target=lambda: CustomDialog(
                                "Successful, running in taskbar",
                                msg_type="success",
                                timeout=5000,
                            ).mainloop()
                        ).start()
                        break
                    else:
                        CustomDialog(
                            "Login successful but websocket connection failed. \nPlease check websocket-url",
                            msg_type="error",
                        ).mainloop()
                else:
                    CustomDialog("Login Failed", msg_type="error").mainloop()

            # generate hashed password for encryption
            if data["cipher_enabled"]:
                salt = (
                    data["username"]
                    + data["password"]
                    + data["server_url"]
                    + data["websocket_url"]
                ).encode("utf-8")
                data["hashed_password"] = hash(
                    data["password"], salt, data["hash_rounds"]
                )
            del data["password"]

            # save data
            with open(DATA_fILE_NAME, "w") as f:
                temp = data.copy()
                if data["cipher_enabled"]:
                    temp["hashed_password"] = base64.b64encode(
                        temp["hashed_password"]
                    ).decode("utf-8")
                json.dump(temp, f, indent=4)

        # subscribe(receive)
        subscribe_ws(
            client,
            data["subscription_destination"],
            data["cipher_enabled"],
            data["hashed_password"],
        )

        threading.Thread(
            target=re_connect_retry_event_trigger,
            args=[
                data["websocket_url"],
                f"JSESSIONID={data['cookie']['JSESSIONID']};",
                data["subscription_destination"],
                data["cipher_enabled"],
                data["hashed_password"],
            ],
        ).start()

        gc.collect()
        time.sleep(0.5)

        # start clipboard monitor(send)
        clipboard_monitor.on_text(
            lambda text: stomp_send(
                text,
                data["send_destination"],
                data["maxsize"],
                data["cipher_enabled"],
                data["hashed_password"],
            )
        )

        # start system tray icon
        sys_tray = TaskbarPanel(
            on_connect_callback=lambda: re_connect(
                data["websocket_url"],
                f"JSESSIONID={data['cookie']['JSESSIONID']};",
                data["subscription_destination"],
                data["cipher_enabled"],
                data["hashed_password"],
            ),
            on_disconnect_callback=lambda: disconnect_client(),
            on_logoff_callback=lambda: logoff_and_exit(client, data, DATA_fILE_NAME),
        )
        sys_tray.run()
    except Exception as e:
        msg = f"An unexpected error has occurred: {e}"
        logging.error(msg)
        CustomDialog(
            msg + "\nCheck logs in project directory", msg_type="error"
        ).mainloop()
    finally:
        disconnect_client()
        kill_re_connect_thread_event_trigger_thread()
