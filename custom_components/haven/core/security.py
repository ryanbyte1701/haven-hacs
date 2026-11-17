"""Small, dependency-free security helpers shared by the web server.

- host_allowed():   Host header allow-list (stops DNS-rebinding pages from talking to Haven)
- AuthLimiter:      slows down password guessing per client address
- BodyLimit:        ASGI wrapper refusing oversized request bodies before they are read
- RateLimiter:      simple token bucket per key (Ecowitt pushes)
- redact():         strips query strings / known secrets from text shown in the UI or logs
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import time
from typing import Iterable

log = logging.getLogger("haven.security")

# Names a rebinding attacker cannot make a victim's browser use for *their* page: IP literals, single-label
# LAN names (diskstation, haven), mDNS and the usual home-network suffixes.
LOCAL_SUFFIXES = (".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain", ".localhost")


def _split_host(host: str) -> str:
    host = (host or "").strip().lower()
    if host.startswith("["):
        return host[1:host.find("]")] if "]" in host else ""
    if host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    return host.rstrip(".")


def extra_hosts() -> set[str]:
    out = set()
    for var in ("HAVEN_ALLOWED_HOSTS", "HAVEN_TLS_HOSTS"):
        for h in os.environ.get(var, "").replace(";", ",").split(","):
            h = _split_host(h)
            if h:
                out.add(h)
    return out


def host_allowed(host_header: str, extra: Iterable[str] | None = None) -> bool:
    host = _split_host(host_header)
    if not host:
        return False
    allowed = set(extra) if extra is not None else extra_hosts()
    if "*" in allowed or host in allowed:
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if "." not in host or host == "localhost":
        return True
    return host.endswith(LOCAL_SUFFIXES)


class AuthLimiter:
    """After `free` failures from one address, each further attempt must wait (doubling, capped)."""

    def __init__(self, free: int = 10, window: float = 600.0, max_delay: float = 300.0) -> None:
        self.free, self.window, self.max_delay = free, window, max_delay
        self.fails: dict[str, tuple[int, float]] = {}

    def retry_after(self, key: str) -> float:
        n, last = self.fails.get(key, (0, 0.0))
        now = time.monotonic()
        if now - last > self.window:
            self.fails.pop(key, None)
            return 0.0
        if n < self.free:
            return 0.0
        wait = min(self.max_delay, 2 ** (n - self.free)) - (now - last)
        return max(0.0, wait)

    def failed(self, key: str) -> None:
        n, last = self.fails.get(key, (0, 0.0))
        if time.monotonic() - last > self.window:
            n = 0
        self.fails[key] = (n + 1, time.monotonic())
        if n + 1 == self.free:
            log.warning("%d wrong dashboard passwords from %s: slowing it down", self.free, key)
        if len(self.fails) > 10000:                       # don't grow forever under a spray
            cutoff = time.monotonic() - self.window
            self.fails = {k: v for k, v in self.fails.items() if v[1] > cutoff}

    def ok(self, key: str) -> None:
        self.fails.pop(key, None)

    # --- "check first, then slow down wrong guesses" (never locks out the right password) ---
    max_penalty = 4.0

    def penalty(self, key: str) -> float:
        """Seconds a wrong guess from `key` waits before it is answered (0 for the first `free`)."""
        n, last = self.fails.get(key, (0, 0.0))
        if time.monotonic() - last > self.window or n < self.free:
            return 0.0
        return min(self.max_penalty, 0.25 * 2 ** (n - self.free))

    def flooding(self, key: str) -> bool:
        """Many wrong guesses from one address waiting at once: answer those at once with 429."""
        return getattr(self, "_waiting", {}).get(key, 0) >= 20

    async def punish(self, key: str) -> None:
        """Count a wrong credential and delay its answer. Wrong guesses from one address are answered
        one at a time; a request with the right credential never waits here."""
        import asyncio
        self.failed(key)
        delay = self.penalty(key)
        if not delay:
            return
        if not hasattr(self, "_locks"):
            self._locks: dict[str, asyncio.Lock] = {}
            self._waiting: dict[str, int] = {}
        lock = self._locks.setdefault(key, asyncio.Lock())
        self._waiting[key] = self._waiting.get(key, 0) + 1
        try:
            async with lock:
                await asyncio.sleep(delay)
        finally:
            self._waiting[key] -= 1
            if not self._waiting[key]:
                self._waiting.pop(key, None)
                self._locks.pop(key, None)


class RateLimiter:
    def __init__(self, rate: float, burst: int) -> None:
        self.rate, self.burst = rate, burst
        self.buckets: dict[str, tuple[float, float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        tokens, last = self.buckets.get(key, (float(self.burst), now))
        tokens = min(self.burst, tokens + (now - last) * self.rate)
        if tokens < 1:
            self.buckets[key] = (tokens, now)
            return False
        self.buckets[key] = (tokens - 1, now)
        if len(self.buckets) > 10000:
            self.buckets = {k: v for k, v in self.buckets.items() if now - v[1] < 60}
        return True


class BodyLimit:
    """ASGI middleware: 413 for bodies over the limit, by Content-Length and while streaming."""

    def __init__(self, app, limits: list[tuple[str, int]], default: int) -> None:
        self.app, self.limits, self.default = app, limits, default

    def limit_for(self, path: str) -> int:
        for prefix, n in self.limits:
            if path.startswith(prefix):
                return n
        return self.default

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        limit = self.limit_for(scope.get("path", ""))
        for k, v in scope.get("headers", []):
            if k == b"content-length":
                try:
                    if int(v) > limit:
                        return await _too_large(send)
                except ValueError:
                    return await _too_large(send)
        seen = 0

        async def limited():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise _TooLarge()
            return msg

        try:
            await self.app(scope, limited, send)
        except _TooLarge:
            try:
                await _too_large(send)
            except Exception:  # noqa: BLE001  (response may have started)
                pass


class _TooLarge(Exception):
    pass


async def _too_large(send):
    await send({"type": "http.response.start", "status": 413,
                "headers": [(b"content-type", b"text/plain"), (b"content-length", b"18")]})
    await send({"type": "http.response.body", "body": b"request too large\n"})


_URL_QS = re.compile(r"(https?://[^\s'\"<>?#]+)\?[^\s'\"<>]*", re.I)
_KV = re.compile(r"(?i)\b(token|api[_-]?key|apikey|key|password|passwd|secret|access_token|auth)=([^&\s'\"]+)")


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    """Remove query strings from URLs, key=value secrets and any known secret values."""
    s = str(text)
    s = _URL_QS.sub(r"\1?…", s)
    s = _KV.sub(r"\1=…", s)
    for sec in secrets:
        if sec and len(str(sec)) >= 4 and str(sec) != "********":
            s = s.replace(str(sec), "…")
    return s


class RedactAccessLog(logging.Filter):
    """uvicorn access log: never write ?token=… (older browsers' WebSocket URLs) to the container log."""

    _tok = re.compile(r"(?i)([?&](?:token|access_token|key)=)[^&\s\"]+")
    _ecowitt = re.compile(r"(/data/report/)[^\s\"?/]+")      # the Ecowitt push secret is a path segment

    def _clean(self, s: str) -> str:
        return self._ecowitt.sub(r"\1…", self._tok.sub(r"\1…", s))

    def filter(self, record: logging.LogRecord) -> bool:
        if record.args and isinstance(record.args, tuple):
            record.args = tuple(self._clean(a) if isinstance(a, str) else a for a in record.args)
        elif isinstance(record.msg, str):
            record.msg = self._clean(record.msg)
        return True
