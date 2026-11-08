"""File clipboard conversion without platform GUI dependencies."""
import base64
import json
import os
from urllib.parse import unquote, urlsplit


def save_download_file(directory, filename, content, reserved_names=()):
    """Save a new copy without replacing an existing file, even between sessions."""
    if not filename or filename in (".", "..") or any(c in filename for c in ("/", "\\", "\0")):
        raise ValueError(f"Invalid download filename: {filename!r}")
    reserved = {name.casefold() for name in reserved_names}
    stem, extension = os.path.splitext(filename)
    candidate = filename
    number = 1
    while True:
        path = os.path.join(directory, candidate)
        try:
            # Exclusive creation also protects against concurrent downloads.
            stream = open(path, "xb")
        except FileExistsError:
            while True:
                candidate = f"{stem} ({number}){extension}"
                number += 1
                if candidate.casefold() not in reserved:
                    break
        else:
            with stream:
                stream.write(content)
            return path


def local_file_paths(paths):
    """Decode local file URLs; never turn remote hosts into local paths."""
    result = []
    for path in paths:
        if path.startswith("#"):
            continue  # text/uri-list comment
        if path.startswith("file:"):
            url = urlsplit(path)
            if url.netloc.lower() not in ("", "localhost"):
                raise ValueError(f"Remote file URL is unsupported: {path}")
            path = unquote(url.path, encoding="utf-8", errors="strict")
        result.append(path)
    return result


def encode_files(file_paths, check_current=lambda: None, with_size=False, raw=False):
    paths = [path for path in file_paths if os.path.isfile(path)]
    reserved = {os.path.basename(path).casefold() for path in paths}
    used = set()
    encoded = {}
    total_size = 0
    for path in paths:
        check_current()
        name = os.path.basename(path)
        stem, extension = os.path.splitext(name)
        candidate = name
        index = 1
        if candidate.casefold() in used:
            while True:
                candidate = f"{stem} ({index}){extension}"
                index += 1
                if candidate.casefold() not in used | reserved:
                    break
        used.add(candidate.casefold())
        with open(path, "rb") as stream:
            parts = []
            # Multiples of three keep concatenated Base64 identical to the
            # legacy whole-file encoding, with no padding between reads.
            while True:
                check_current()
                block = stream.read(3 * 256 * 1024)
                if not block:
                    break
                total_size += len(block)
                parts.append(block if raw else base64.b64encode(block).decode("ascii"))
            encoded[candidate] = b"".join(parts) if raw else "".join(parts)
            del parts
    check_current()
    payload = encoded if raw else json.dumps(encoded)
    return (payload, total_size) if with_size else payload
