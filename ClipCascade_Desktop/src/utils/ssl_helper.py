import os
import ssl
from typing import Any, Dict, Optional, Union

from core.constants import MACOS, PLATFORM

if PLATFORM == MACOS:
    import certifi


def requests_verify_arg(config) -> Union[bool, str]:
    """Argument for requests' verify= when calling the user's server."""
    path = (config.data.get("ssl_ca_bundle") or "").strip()
    if not path:
        return True
    if not os.path.isfile(path):
        raise FileNotFoundError(f"SSL CA bundle file not found: {path}")
    return path


def websocket_sslopt_for_config(config) -> Optional[Dict[str, Any]]:
    """sslopt for websocket_client run_forever; None uses the library/OS default."""
    path = (config.data.get("ssl_ca_bundle") or "").strip()
    if path:
        if not os.path.isfile(path):
            raise FileNotFoundError(f"SSL CA bundle file not found: {path}")
        ctx = ssl.create_default_context(cafile=path)
        return {"context": ctx}
    if PLATFORM == MACOS:
        ctx = ssl.create_default_context(cafile=certifi.where())
        return {"context": ctx}
    return None
