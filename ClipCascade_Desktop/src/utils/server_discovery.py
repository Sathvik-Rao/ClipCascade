"""Refresh transport settings without changing the authentication session."""
from core.config import Config
from core.constants import WEBSOCKET_ENDPOINT, WEBSOCKET_ENDPOINT_P2P


def discover_server(config, request_manager):
    data = config.data

    def fetch(path):
        response = request_manager.get(
            url=data["server_url"].rstrip("/") + path,
            headers={"Cookie": request_manager.format_cookie(data["cookie"]),
                     "Cache-Control": "no-cache"},
            verify=request_manager._verify(), timeout=10,
        )
        return response.json()

    try:
        mode = fetch("/server-mode").get("mode")
    except Exception as error:
        # Only a missing endpoint permits legacy cached settings. Outages and
        # authentication failures must not silently select the wrong transport.
        if getattr(getattr(error, "response", None), "status_code", None) == 404:
            if data.get("server_mode") in ("P2P", "P2S") and data.get("websocket_url"):
                return
        raise
    if mode not in ("P2P", "P2S"):
        raise ValueError(f"Unsupported server mode: {mode}")
    settings = {"server_mode": mode}
    if mode == "P2P":
        stun = fetch("/stun-url")["url"]
        if not isinstance(stun, str):
            raise ValueError("Invalid server STUN URL")
        settings.update(stun_url=stun, maxsize=-1)
        endpoint = WEBSOCKET_ENDPOINT_P2P
    else:
        limit = fetch("/max-size")["maxsize"]
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
            raise ValueError("Invalid server clipboard size limit")
        settings.update(stun_url="", maxsize=limit)
        endpoint = WEBSOCKET_ENDPOINT
    settings["websocket_url"] = Config.convert_to_websocket_url(data["server_url"], endpoint)
    # Publish only after every required request succeeds.
    data.update(settings)
