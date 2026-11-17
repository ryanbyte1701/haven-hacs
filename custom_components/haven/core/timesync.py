"""Date & time: SNTP client + timezone.

A container can't change the host's system clock, so Haven measures the clock's offset against
NTP servers and uses the corrected time (now()) for automations, and shows the drift in Settings.
Stdlib only (UDP port 123).
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import statistics
import struct
import time
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("time")

NTP_EPOCH = 2208988800          # seconds between 1900-01-01 and 1970-01-01
DEFAULT_SERVERS = ["pool.ntp.org", "time.cloudflare.com"]
MAX_OFFSET = 300               # seconds: larger NTP offsets are reported, not applied


def _to_ntp(ts: float) -> bytes:
    sec = int(ts) + NTP_EPOCH
    frac = int((ts - int(ts)) * 2**32) & 0xFFFFFFFF
    return struct.pack("!II", sec, frac)


def _from_ntp(b: bytes) -> float:
    sec, frac = struct.unpack("!II", b)
    return sec - NTP_EPOCH + frac / 2**32


def build_request(t1: float) -> bytes:
    """48-byte SNTP v4 client request with our transmit timestamp."""
    return bytes([0x23]) + bytes(39) + _to_ntp(t1)          # LI=0, VN=4, Mode=3 (client)


def parse_response(data: bytes, t1: float, t4: float, sent: bytes | None = None) -> tuple[float, float]:
    """Return (offset, delay) in seconds per RFC 4330. With `sent` (the 8-byte transmit timestamp of our
    request), the reply's originate timestamp must echo it: anything else is a stale, stray or spoofed packet."""
    if len(data) < 48:
        raise ValueError("short NTP packet")
    mode, stratum = data[0] & 0x7, data[1]
    if mode not in (4, 5) or stratum == 0:
        raise ValueError(f"bad NTP reply (mode {mode}, stratum {stratum})")
    if sent is not None and data[24:32] != sent:
        raise ValueError("NTP reply does not match our request")
    t2, t3 = _from_ntp(data[32:40]), _from_ntp(data[40:48])
    offset = ((t2 - t1) + (t3 - t4)) / 2
    delay = (t4 - t1) - (t3 - t2)
    return offset, delay


def _same_addr(a, b) -> bool:
    return a[0] == b[0] and a[1] == b[1]


def query(host: str, port: int = 123, timeout: float = 2.0) -> tuple[float, float]:
    """Blocking single SNTP query (run in a thread). Only a reply from the address we asked, echoing our
    transmit timestamp, is accepted; other packets are ignored until the timeout."""
    addr = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)[0]
    with socket.socket(addr[0], socket.SOCK_DGRAM) as s:
        t1 = time.time()
        req = build_request(t1)
        sent = req[40:48]
        deadline = time.monotonic() + timeout
        s.settimeout(timeout)
        s.sendto(req, addr[4])
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("no matching NTP reply")
            s.settimeout(left)
            data, src = s.recvfrom(512)
            t4 = time.time()
            if not _same_addr(src, addr[4]) or data[24:32] != sent:
                log.debug("NTP: ignoring unexpected packet from %s", src[0])
                continue
            return parse_response(data, t1, t4, sent)


class TimeService:
    def __init__(self) -> None:
        self.offset = 0.0
        self.delay = 0.0
        self.last_sync: float | None = None
        self.error: str | None = None
        self.servers: list[str] = list(DEFAULT_SERVERS)
        self.sync_minutes = 60.0
        self.tzname = os.getenv("TZ") or "UTC"
        self.time_format = "12h"
        self.enabled = True
        self._task: asyncio.Task | None = None
        self.query = query          # injectable for tests

    # ----- config -----
    async def configure(self, cfg: dict | None) -> None:
        cfg = cfg or {}
        self.enabled = cfg.get("enabled", True)
        servers = cfg.get("ntp_servers")
        self.servers = [str(s) for s in servers] if servers else list(DEFAULT_SERVERS)
        try:
            self.sync_minutes = max(1.0, float(cfg.get("sync_minutes") or 60))
        except (TypeError, ValueError):
            self.sync_minutes = 60.0
        self.tzname = str(cfg.get("timezone") or os.getenv("TZ") or "UTC")
        self.time_format = cfg.get("time_format") or "12h"
        await self.stop()
        if self.enabled:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None

    @property
    def tz(self):
        try:
            return ZoneInfo(self.tzname)
        except (ZoneInfoNotFoundError, ValueError):
            return ZoneInfo("UTC")

    def now(self) -> float:
        return time.time() + (self.offset if self.enabled else 0.0)

    def local(self, ts: float | None = None) -> datetime:
        return datetime.fromtimestamp(self.now() if ts is None else ts, self.tz)

    # ----- syncing -----
    async def sync_once(self) -> bool:
        samples: list[tuple[float, float]] = []
        errors = []
        for host in self.servers:
            for _ in range(2):
                try:
                    samples.append(await asyncio.to_thread(self.query, host))
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{host}: {e}")
                    break
        good = [s for s in samples if 0 <= s[1] < 1.0]       # ignore replies with absurd round trips
        if not good:
            self.error = "; ".join(errors[:2]) or "no usable replies"
            return False
        offset = statistics.median(s[0] for s in good)
        if abs(offset) > MAX_OFFSET:
            # A huge offset means the NAS clock (or a spoofed NTP reply) is badly wrong: don't shift
            # every schedule by it, keep the previous correction and tell the user.
            self.error = f"clock offset too large: {offset:+.0f}s — fix the NAS clock"
            log.warning("NTP: ignoring offset of %.0f s (limit %d s)", offset, MAX_OFFSET)
            return False
        self.offset = offset
        self.delay = statistics.median(s[1] for s in good)
        self.last_sync = time.time()
        self.error = None
        return True

    async def _loop(self) -> None:
        while True:
            ok = await self.sync_once()
            if not ok:
                log.warning("NTP sync failed: %s", self.error)
            await asyncio.sleep(self.sync_minutes * 60 if ok else 120)

    def status(self) -> dict:
        tz_ok = True
        try:
            ZoneInfo(self.tzname)
        except (ZoneInfoNotFoundError, ValueError):
            tz_ok = False
        return {"enabled": self.enabled, "servers": self.servers, "offset_ms": round(self.offset * 1000, 1),
                "delay_ms": round(self.delay * 1000, 1), "last_sync": self.last_sync, "ok": self.last_sync is not None and not self.error,
                "error": self.error, "timezone": self.tzname, "timezone_valid": tz_ok, "time_format": self.time_format,
                "now": self.now(), "local": self.local().isoformat(timespec="seconds")}

    @property
    def status_line(self) -> str:
        if not self.enabled:
            return "off"
        tz = self.tzname if self.status()["timezone_valid"] else f"unknown timezone {self.tzname}, using UTC"
        if self.error and self.error.startswith("clock offset too large"):
            return f"error: {self.error} · {tz}"
        if self.error and self.last_sync is None:
            return f"error: NTP unreachable ({self.error.split(';')[0]})"
        if self.last_sync is None:
            return f"starting · {tz}"
        sign = "+" if self.offset >= 0 else "−"
        return f"ok · offset {sign}{abs(self.offset) * 1000:.0f} ms · {tz}"
