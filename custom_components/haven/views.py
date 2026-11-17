"""Home Assistant HTTP views that hand requests to Haven (bridge.py)."""
from __future__ import annotations

from aiohttp import web

from homeassistant.components.http import HomeAssistantView

from .const import API_PREFIX, WS_URL


class HavenWebSocketView(HomeAssistantView):
    """Haven's live updates. Browsers can't send headers with a WebSocket, so like Home Assistant's own
    /api/websocket it signs in with its first message (checked in bridge.py / auth_bridge.py)."""

    url = WS_URL
    name = "api:haven:websocket"
    requires_auth = False

    def __init__(self, runtime) -> None:
        self.runtime = runtime

    async def get(self, request: web.Request) -> web.StreamResponse:
        return await self.runtime.bridge.handle_ws(request, "/ws")


class HavenApiView(HomeAssistantView):
    """Everything under /api/haven/: Home Assistant checks the Bearer token before Haven sees the request."""

    url = API_PREFIX + "/{path:.*}"
    name = "api:haven"
    requires_auth = True

    def __init__(self, runtime) -> None:
        self.runtime = runtime

    async def _handle(self, request: web.Request, path: str) -> web.StreamResponse:
        return await self.runtime.bridge.handle_http(request, "/api/" + path)

    get = post = put = patch = delete = _handle
