"""Runs Haven's FastAPI app (core/main.py) inside Home Assistant, behind Home Assistant's own web server.

Home Assistant's aiohttp server receives the requests (so its sign-in, TLS, reverse-proxy and remote-access
setup all apply) and this module hands them to Haven's ASGI app:

    browser ─ /api/haven/<x> ───────────► HavenApiView (HA checks the Bearer token) ─► ASGI  /api/<x>
    browser ─ /api/haven/websocket ─────► HavenWebSocketView ─────────────────────────► ASGI  /ws

Haven runs in its own thread with its own event loop. Its code was written for a server of its own: it reads and
writes small files, and its history database, on its loop. In a thread of its own that never holds up Home
Assistant's event loop, and a busy Haven can't make Home Assistant slow. Requests, responses and WebSocket
messages cross between the two loops here. No second port, no uvicorn.

Paths the HACS edition doesn't serve (core/edition.py path_blocked) answer 404.
Pure aiohttp + ASGI: nothing here imports Home Assistant, so it is tested without it (tests/test_hacs_build.py).
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import threading
from typing import Any, Callable

from aiohttp import WSMsgType, web

log = logging.getLogger(__name__)

# Request headers never passed on to Haven: Home Assistant's own cookies, hop-by-hop headers, and Host/Origin
# (Haven checks those against its own LAN names; Home Assistant already decided this request may come in, and
# every call carries a token, so a browser can't be tricked into making one).
DROP_REQUEST = {"host", "origin", "cookie", "connection", "upgrade", "keep-alive", "transfer-encoding",
                "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol",
                "x-forwarded-host"}
DROP_RESPONSE = {"content-length", "transfer-encoding", "connection", "keep-alive", "x-frame-options",
                 "content-security-policy"}
ASGI = {"version": "3.0", "spec_version": "2.3"}


class AsgiBridge:
    """One ASGI application, with its lifespan, in its own thread and event loop, served through aiohttp."""

    def __init__(self, app: Callable, *, blocked: Callable[[str], bool] = lambda p: False,
                 ws_token: Callable[[str], str | None] | None = None,
                 on_request: Callable[[web.Request], None] | None = None, thread_name: str = "haven") -> None:
        self.app = app
        self.blocked = blocked
        self.ws_token = ws_token          # HA access token -> the token Haven's /ws gets (None = refused)
        self.on_request = on_request      # called in Home Assistant's loop before a request is handed over
        self.thread_name = thread_name
        self.running = False
        self.state: dict[str, Any] = {}
        self.loop: asyncio.AbstractEventLoop | None = None      # Haven's
        self._thread: threading.Thread | None = None
        self._lifespan: asyncio.Future | None = None
        self._lq: asyncio.Queue | None = None
        self._started: asyncio.Future | None = None
        self._stopped: asyncio.Future | None = None
        self._sockets: set[web.WebSocketResponse] = set()

    # ---------------- Haven's loop ----------------
    def _start_thread(self) -> None:
        ready = threading.Event()

        def run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self.loop = loop
            ready.set()
            try:
                loop.run_forever()
            finally:
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                finally:
                    loop.close()

        self._thread = threading.Thread(target=run, name=self.thread_name, daemon=True)
        self._thread.start()
        if not ready.wait(10):
            raise RuntimeError("Haven's thread didn't start")

    async def _in_haven(self, coro):
        """Run a coroutine in Haven's loop and wait for it from the caller's loop."""
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, self.loop))

    # ---------------- lifespan ----------------
    async def startup(self) -> None:
        if self.loop is None:
            self._start_thread()
        await self._in_haven(self._startup())
        self.running = True

    async def _startup(self) -> None:
        loop = asyncio.get_running_loop()
        self._lq = asyncio.Queue()
        self._started, self._stopped = loop.create_future(), loop.create_future()

        async def receive():
            return await self._lq.get()

        async def send(msg):
            t = msg["type"]
            if t == "lifespan.startup.complete":
                self._started.set_result(None)
            elif t == "lifespan.startup.failed":
                self._started.set_exception(RuntimeError(msg.get("message") or "Haven failed to start"))
            elif t == "lifespan.shutdown.complete":
                self._stopped.set_result(None)
            elif t == "lifespan.shutdown.failed":
                self._stopped.set_exception(RuntimeError(msg.get("message") or "Haven failed to stop"))

        scope = {"type": "lifespan", "asgi": ASGI, "state": self.state}
        task = asyncio.ensure_future(self.app(scope, receive, send))
        self._lifespan = task
        await self._lq.put({"type": "lifespan.startup"})
        await asyncio.wait({self._started, task}, return_when=asyncio.FIRST_COMPLETED)
        if not self._started.done():
            exc = task.exception() if not task.cancelled() else None
            raise RuntimeError(f"Haven's app ended during startup: {exc}")
        self._started.result()

    async def shutdown(self) -> None:
        """Stop Haven (its device source, automations and history) and its thread."""
        self.running = False
        for ws in list(self._sockets):
            await ws.close(code=1001, message=b"Haven is stopping")
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            await asyncio.wait_for(self._in_haven(self._shutdown()), 30)
        except Exception as e:  # noqa: BLE001
            log.warning("Haven stopped with an error: %s", e)
        loop.call_soon_threadsafe(loop.stop)
        if self._thread is not None:
            await asyncio.get_running_loop().run_in_executor(None, self._thread.join, 10)
        self.loop = None

    async def _shutdown(self) -> None:
        if self._lifespan is None or self._lifespan.done():
            return
        await self._lq.put({"type": "lifespan.shutdown"})
        await asyncio.wait({self._stopped, self._lifespan}, timeout=25, return_when=asyncio.FIRST_COMPLETED)
        if self._stopped.done():
            self._stopped.result()

    # ---------------- HTTP ----------------
    def _headers(self, request: web.Request) -> list[tuple[bytes, bytes]]:
        out = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in request.headers.items()
               if k.lower() not in DROP_REQUEST]
        out.append((b"host", b"localhost"))
        return out

    def _scope(self, request: web.Request, kind: str, path: str) -> dict:
        return {
            "type": kind, "asgi": ASGI, "http_version": "1.1", "scheme": "http" if kind == "http" else "ws",
            "path": path, "raw_path": path.encode(), "root_path": "",
            "query_string": request.rel_url.raw_query_string.encode("latin-1"),
            "headers": self._headers(request), "client": (request.remote or "?", 0), "server": ("localhost", 80),
            "state": dict(self.state),
            **({"method": request.method} if kind == "http" else {"subprotocols": []}),
        }

    async def handle_http(self, request: web.Request, haven_path: str) -> web.StreamResponse:
        """Serve one request (in Home Assistant's loop); haven_path is Haven's own path, e.g. /api/devices."""
        if not self.running:
            return web.json_response({"detail": "Haven is not running (restart the Haven integration)"}, status=503)
        if self.blocked(haven_path):
            return web.json_response({"detail": "not available in Haven for Home Assistant"}, status=404)
        body = await request.read()
        if self.on_request is not None:
            self.on_request(request)
        scope = self._scope(request, "http", haven_path)
        try:
            status, headers, content = await self._in_haven(self._call_http(scope, body))
        except Exception:  # noqa: BLE001
            log.exception("Haven failed on %s %s", request.method, haven_path)
            return web.json_response({"detail": "Haven had an internal error (see the Home Assistant log)"}, status=500)
        resp = web.Response(status=status, body=content)
        for k, v in headers:
            name = k.decode("latin-1")
            if name.lower() not in DROP_RESPONSE:
                resp.headers.add(name, v.decode("latin-1"))
        resp.headers.setdefault("Cache-Control", "no-store")
        return resp

    async def _call_http(self, scope: dict, body: bytes):
        """In Haven's loop: run the app for one request, return (status, headers, body)."""
        done = asyncio.Event()
        sent = False
        status, headers, chunks = 500, [], []

        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            await done.wait()
            return {"type": "http.disconnect"}

        async def send(msg):
            nonlocal status, headers
            if msg["type"] == "http.response.start":
                status, headers = msg["status"], msg.get("headers") or []
            elif msg["type"] == "http.response.body":
                chunks.append(msg.get("body") or b"")
                if not msg.get("more_body"):
                    done.set()

        try:
            await self.app(scope, receive, send)
        finally:
            done.set()
        return status, headers, b"".join(chunks)

    # ---------------- WebSocket ----------------
    async def handle_ws(self, request: web.Request, haven_path: str = "/ws") -> web.StreamResponse:
        """Haven's live updates. The browser signs in with its first message ({"type": "auth", "token": <Home
        Assistant access token>}); the token is checked here and swapped for the one Haven's /ws expects."""
        ws = web.WebSocketResponse(max_msg_size=1024 * 1024)
        await ws.prepare(request)
        if not self.running:
            await ws.close(code=1013, message=b"Haven is not running")
            return ws
        self._sockets.add(ws)
        ha_loop = asyncio.get_running_loop()
        haven_loop = self.loop
        inbound: asyncio.Queue = asyncio.Queue()            # used in Haven's loop only

        def deliver(msg: dict) -> None:                     # Home Assistant's loop -> Haven's
            haven_loop.call_soon_threadsafe(inbound.put_nowait, msg)

        deliver({"type": "websocket.connect"})

        async def receive():
            return await inbound.get()

        async def on_ha(coro):
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, ha_loop))

        async def send(msg):                                # in Haven's loop
            t = msg["type"]
            if t == "websocket.accept":
                return
            from starlette.websockets import WebSocketDisconnect
            if ws.closed:
                raise WebSocketDisconnect(ws.close_code or 1006)
            try:
                if t == "websocket.send":
                    if msg.get("text") is not None:
                        await on_ha(ws.send_str(msg["text"]))
                    else:
                        await on_ha(ws.send_bytes(msg.get("bytes") or b""))
                elif t == "websocket.close":
                    await on_ha(ws.close(code=msg.get("code", 1000), message=(msg.get("reason") or "").encode()))
            except (ConnectionError, RuntimeError) as e:
                raise WebSocketDisconnect(1006) from e

        app_run = asyncio.run_coroutine_threadsafe(
            self.app(self._scope(request, "websocket", haven_path), receive, send), haven_loop)
        app_done = asyncio.wrap_future(app_run)
        first = True
        reading: asyncio.Future | None = None
        try:
            # Read the browser's side all the time (Haven only reads the first message), so a closed socket is
            # noticed at once and Haven's handler stops instead of waiting for its next ping.
            while True:
                reading = asyncio.ensure_future(ws.receive())
                done, _ = await asyncio.wait({reading, app_done}, return_when=asyncio.FIRST_COMPLETED)
                if reading not in done:                     # Haven ended the connection
                    break
                msg = reading.result()
                if msg.type == WSMsgType.TEXT:
                    data = msg.data
                    if first:
                        first = False
                        data = self._swap_token(data)
                    deliver({"type": "websocket.receive", "text": data})
                elif msg.type == WSMsgType.BINARY:
                    deliver({"type": "websocket.receive", "bytes": msg.data})
                else:                                       # closed, closing or error
                    deliver({"type": "websocket.disconnect", "code": ws.close_code or 1005})
                    app_run.cancel()
                    break
            try:
                await asyncio.wait_for(asyncio.shield(app_done), 5)
            except (asyncio.TimeoutError, asyncio.CancelledError, concurrent.futures.CancelledError):
                if asyncio.current_task().cancelling():
                    raise
            except Exception:  # noqa: BLE001
                log.debug("Haven live updates ended with an error", exc_info=True)
        finally:
            if reading is not None and not reading.done():
                reading.cancel()
            if not app_run.done():
                app_run.cancel()
            self._sockets.discard(ws)
            if not ws.closed:
                await ws.close()
        return ws

    def _swap_token(self, data: str) -> str:
        if self.ws_token is None:
            return data
        try:
            m = json.loads(data)
        except ValueError:
            return data
        if isinstance(m, dict) and m.get("type") == "auth":
            m["token"] = self.ws_token(str(m.get("token") or "")) or ""
            return json.dumps(m)
        return data
