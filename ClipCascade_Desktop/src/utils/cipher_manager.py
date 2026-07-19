import base64
import json
import hashlib

from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
from core.constants import *
from core.config import Config

# 96 bits, the size GCM is specified around (NIST SP 800-38D) and the only size
# Apple's CryptoKit accepts: AES.GCM.Nonce(data:) rejects anything else, so a
# 16-byte nonce is undecryptable on iOS. PyCryptodome defaults to 16 when no
# nonce is passed; Android's GCMParameterSpec accepts any length. 12 is
# therefore the one value every client can read.
GCM_NONCE_SIZE_BYTES = 12


class CipherManager:
    def __init__(self, config: Config):
        self.config = config

        # hash
        self.hash_name = "sha256"
        self.dklen = 32  # 256 bits for AES-256

        # encryption
        self.mode = AES.MODE_GCM

    def hash_password(self, password: str) -> bytes:
        return hashlib.pbkdf2_hmac(
            hash_name=self.hash_name,
            password=password.encode(),
            salt=(
                self.config.data["username"] + password + self.config.data["salt"]
            ).encode("utf-8"),
            iterations=self.config.data["hash_rounds"],
            dklen=self.dklen,
        )

    def encrypt(self, plaintext: str, aad: bytes | None = None) -> dict:
        key = self.config.data["hashed_password"]
        plaintext_bytes = plaintext.encode("utf-8")
        cipher = AES.new(key, self.mode, nonce=get_random_bytes(GCM_NONCE_SIZE_BYTES))
        if aad:
            cipher.update(aad)
        ciphertext, tag = cipher.encrypt_and_digest(plaintext_bytes)
        return {"nonce": cipher.nonce, "ciphertext": ciphertext, "tag": tag}

    def decrypt(
        self,
        nonce: bytes,
        ciphertext: bytes,
        tag: bytes,
        aad: bytes | None = None,
    ) -> str:
        key = self.config.data["hashed_password"]
        cipher = AES.new(key, self.mode, nonce=nonce)
        if aad:
            cipher.update(aad)
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

        # Decode known ciphertext fields; ignore non-crypto flags like bound:true.
        for key, value in json_data.items():
            if key not in {"nonce", "ciphertext", "tag"}:
                continue
            if isinstance(value, str):
                decoded_data[key] = base64.b64decode(value)
            else:
                raise ValueError(
                    f"Unsupported value type for key '{key}': {type(value)}. "
                    + f"Expected 'str' for Base64 decoding."
                )
        if not {"nonce", "ciphertext", "tag"}.issubset(decoded_data):
            raise ValueError("Encrypted payload missing nonce/ciphertext/tag")
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
