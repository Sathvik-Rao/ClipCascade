import base64
import json
import hashlib

from Crypto.Cipher import AES
from core.constants import *
from core.config import Config


class CipherManager:
    def __init__(self, config: Config):
        self.config = config

        # hash
        self.hash_name = "sha256"
        self.dklen = 32  # 256 bits for AES-256

        # encryption
        self.mode = AES.MODE_GCM

    def hash_password(self) -> bytes:
        return hashlib.pbkdf2_hmac(
            hash_name=self.hash_name,
            password=self.config.data["password"].encode(),
            salt=(
                self.config.data["username"]
                + self.config.data["password"]
                + self.config.data["salt"]
            ).encode("utf-8"),
            iterations=self.config.data["hash_rounds"],
            dklen=self.dklen,
        )

    def encrypt(self, plaintext: str) -> dict:
        key = self.config.data["hashed_password"]
        plaintext_bytes = plaintext.encode("utf-8")
        cipher = AES.new(key, self.mode)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext_bytes)
        return {"nonce": cipher.nonce, "ciphertext": ciphertext, "tag": tag}

    def decrypt(self, nonce: bytes, ciphertext: bytes, tag: bytes) -> str:
        key = self.config.data["hashed_password"]
        cipher = AES.new(key, self.mode, nonce=nonce)
        return cipher.decrypt_and_verify(ciphertext, tag).decode()

    @staticmethod
    def encode_to_json_string(**kwargs: bytes) -> str:
        """
        Convert bytes values to Base64 and create a JSON string.

        Args:
            **kwargs: Key-value pairs where values must be of type `bytes`.

        Returns:
            str: A JSON string with all `bytes` values Base64-encoded.

        Raises:
            ValueError: If a value is not of type `bytes`.
        """
        json_data = {}
        for key, value in kwargs.items():
            if isinstance(value, bytes):
                json_data[key] = base64.b64encode(value).decode("utf-8")
            else:
                raise ValueError(
                    f"Unsupported value type for key '{key}': {type(value)}. "
                    f"This method only supports 'bytes'."
                )
        return json.dumps(json_data)

    @staticmethod
    def decode_from_json_string(json_string: str) -> dict:
        """
        Decode a JSON string where all values are Base64-encoded back to their original bytes.

        Args:
            json_string (str): A JSON string with Base64-encoded values.

        Returns:
            dict: A dictionary with the original keys and `bytes` values decoded from Base64.

        Raises:
            ValueError: If the JSON string is not valid or if decoding fails.
        """
        # Parse the JSON string into a dictionary
        json_data = json.loads(json_string)
        decoded_data = {}

        # Decode each Base64-encoded value back to bytes
        for key, value in json_data.items():
            if isinstance(value, str):
                decoded_data[key] = base64.b64decode(value)
            else:
                raise ValueError(
                    f"Unsupported value type for key '{key}': {type(value)}. "
                    + f"Expected 'str' for Base64 decoding."
                )
        return decoded_data

    @staticmethod
    def string_to_sha3_512_lowercase_hex(input_string: str) -> str:
        """
        Convert a string to its lowercase hexadecimal SHA3-512 hash.

        Args:
            input_string (str): The input string to hash.

        Returns:
            str: The lowercase hexadecimal representation of the SHA3-512 hash.
        """
        return hashlib.sha3_512(input_string.encode("utf-8")).hexdigest()
