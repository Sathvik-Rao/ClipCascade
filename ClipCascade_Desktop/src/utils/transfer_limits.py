"""Optional original-content sizes and receive capabilities for legacy transports."""
import json
import re

MAX_SIZE = 2 ** 53 - 1
SIZE_FIELD = "contentSizeBytes"
LIMIT_HEADER = "x-clipcascade-receive-limit"


def valid_size(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SIZE


def receive_limit(config):
    value = config.data.get("max_clipboard_size_local_limit_bytes")
    return value if valid_size(value) else None


def receive_limit_header(config):
    value = receive_limit(config)
    return "unlimited" if value is None else str(value)


def capability_message(config):
    return json.dumps({"_cc_keepalive": True,
                       "capabilities": {"version": 1, "transferFormats": ["ccb1"], "receiveLimitBytes": receive_limit(config)}})


def read_capability(message, limits, peer):
    capability = message.get("capabilities")
    if not isinstance(capability, dict) or capability.get("version") != 1:
        return
    if "receiveLimitBytes" not in capability:
        return
    value = capability["receiveLimitBytes"]
    if value is None or valid_size(value):
        limits[peer] = value


def allows_content(limit, size):
    return not valid_size(limit) or not valid_size(size) or size <= limit


def metadata_size(metadata):
    value = metadata.get(SIZE_FIELD) if isinstance(metadata, dict) else None
    return value if valid_size(value) else None


def base64_size(value):
    """Decoded length without allocating the decoded content."""
    length = len(value) - sum(len(match[0]) for match in re.finditer(r"\s+", value))
    end = len(value) - 1
    padding = 0
    while end >= 0 and (value[end].isspace() or value[end] == "="):
        padding += value[end] == "="
        end -= 1
    return (length // 4) * 3 - padding


def content_size(payload, kind):
    """Original bytes, excluding Base64, JSON, and encryption overhead."""
    if kind == "text":
        return len(payload.encode("utf-8"))
    if kind == "image":
        return len(payload) if isinstance(payload, bytes) else base64_size(payload)
    if kind == "files":
        return (sum(len(value) for value in payload.values()) if isinstance(payload, dict) else
                sum(base64_size(value) for value in json.loads(payload).values()))
    return None
