"""File clipboard conversion without platform GUI dependencies."""
import base64
import json
import os
from urllib.parse import unquote, urlsplit


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


def encode_files(file_paths):
    paths = [path for path in file_paths if os.path.isfile(path)]
    reserved = {os.path.basename(path).casefold() for path in paths}
    used = set()
    encoded = {}
    for path in paths:
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
            encoded[candidate] = base64.b64encode(stream.read()).decode("ascii")
    return json.dumps(encoded)
