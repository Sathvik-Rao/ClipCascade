"""CCB1: bounded JSON headers and opaque bytes; legacy clipboard adapters at edges."""
import base64
import json
import struct

MAGIC = b"CCB1"
MAX_HEADER = 65536
FORMAT = "ccb1"
CONTENT_TYPE = "application/octet-stream"


def pack(header, payload):
    encoded = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_HEADER:
        raise ValueError("Binary header too large")
    return MAGIC + struct.pack(">I", len(encoded)) + encoded + payload


def unpack(data):
    if not isinstance(data, bytes) or len(data) < 8 or data[:4] != MAGIC:
        raise ValueError("Invalid binary frame")
    size = struct.unpack(">I", data[4:8])[0]
    if size > MAX_HEADER or size > len(data) - 8:
        raise ValueError("Invalid binary header length")
    header = json.loads(data[8:8 + size].decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError("Invalid binary header")
    return header, data[8 + size:]


def original_content(payload, kind):
    """Normalize legacy input once at ingress; modern adapters already return bytes."""
    if kind == "text":
        return payload
    if kind == "image":
        return payload if isinstance(payload, bytes) else base64.b64decode("".join(payload.split()), validate=True)
    if kind == "files":
        if isinstance(payload, dict):
            return payload
        return {name: base64.b64decode("".join(value.split()), validate=True)
                for name, value in json.loads(payload).items()}
    raise ValueError("Unsupported content type")


def legacy_content(payload, kind):
    if kind == "text" or isinstance(payload, str):
        return payload
    if kind == "image":
        return base64.b64encode(payload).decode("ascii")
    return json.dumps({name: base64.b64encode(value).decode("ascii") for name, value in payload.items()})


def content_parts(payload, kind):
    payload = original_content(payload, kind)
    if kind == "text":
        return {"type": kind, "files": None}, [payload.encode("utf-8")]
    if kind == "image":
        return {"type": kind, "files": None}, [payload]
    return {"type": kind, "files": [[name, len(value)] for name, value in payload.items()]}, list(payload.values())


def encode_content(payload, kind, cipher=None, on_raw_size=lambda size: None):
    header, parts = content_parts(payload, kind)
    # One allocation for the complete plaintext, without a second joined file body.
    prefix = pack(header, b"")
    raw = b"".join([prefix, *parts])
    # Kind and file boundaries are inside the authenticated plaintext.
    on_raw_size(len(raw))
    if cipher is not None:
        envelope = cipher.encrypt_bytes(raw)
        raw = bytes([len(envelope["nonce"])]) + envelope["nonce"] + envelope["tag"] + envelope["ciphertext"]
    return raw


def decode_content(raw, kind, cipher=None, limit=None):
    if limit is not None and limit >= 0 and len(raw) > limit + MAX_HEADER + 64:
        raise ValueError("Binary content exceeds receive limit")
    if cipher is not None:
        if not raw or not 8 <= raw[0] <= 32 or len(raw) < 1 + raw[0] + 16:
            raise ValueError("Invalid encrypted binary payload")
        n = raw[0]
        raw = cipher.decrypt_bytes(raw[1:1+n], raw[1+n+16:], raw[1+n:1+n+16])
    header, raw = unpack(raw)
    if header.get("type") != kind:
        raise ValueError("Content type mismatch")
    if limit is not None and limit >= 0 and len(raw) > limit:
        raise ValueError("Binary content exceeds receive limit")
    if kind == "text":
        return raw.decode("utf-8")
    if kind == "image":
        return raw
    if kind != "files" or not isinstance(header.get("files"), list):
        raise ValueError("Invalid binary content")
    result, offset = {}, 0
    for entry in header["files"]:
        if not isinstance(entry, list) or len(entry) != 2:
            raise ValueError("Invalid file entry")
        name, size = entry
        if (not isinstance(name, str) or not name or name in result
                or any(c in name for c in ("/", "\\", "\0")) or name in (".", "..")
                or not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > len(raw) - offset):
            raise ValueError("Invalid file entry")
        result[name] = raw[offset:offset+size]
        offset += size
    if offset != len(raw):
        raise ValueError("Trailing binary content")
    return result


def encode_frame(payload, kind, metadata, encrypted=False):
    return pack({"type": kind, "metadata": metadata, "encrypted": encrypted}, payload)


def decode_frame(data):
    header, payload = unpack(data)
    if header.get("type") not in ("text", "image", "files") or type(header.get("encrypted")) is not bool:
        raise ValueError("Invalid binary envelope")
    metadata = header.get("metadata")
    size = metadata.get("contentSizeBytes") if isinstance(metadata, dict) else None
    if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= 2 ** 53 - 1:
        raise ValueError("Invalid binary content size")
    if "totalFragments" in metadata:
        total, index = metadata.get("totalFragments"), metadata.get("index")
        if (type(total) is not int or type(index) is not int or not 1 <= total <= 65536
                or not 0 <= index < total or metadata.get("isFragmented") != (total > 1)
                or not isinstance(metadata.get("id"), str) or not metadata["id"] or len(payload) > 15360):
            raise ValueError("Invalid binary fragments")
    header["payload"] = payload
    header["_cc_binary"] = True
    return header
