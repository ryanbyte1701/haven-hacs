"""Automations: "when <trigger>, if <conditions>, then <actions>".

Triggers   device   {device_id, capability, op: changes|becomes|above|below|equals, value}
           time     {at: "HH:MM", days: ["mon", ...]}      (empty days = every day)
           interval {minutes: N}
Conditions device   {device_id, capability, op: becomes|equals|above|below|changes(=any)}  current state
           time     {after: "HH:MM", before: "HH:MM"}      (wraps past midnight when after > before)
           days     {days: ["sat", "sun"]}
Actions    command  {device_id, capability, value}
           notify   {message, title?}
           delay    {seconds}  (max 3600)
           webhook  {url, method: POST|GET, body?}

Device triggers fire on transitions only, so repeated identical reports don't re-run a rule, and
are rate-limited to one run per MIN_DEVICE_COOLDOWN seconds (or the rule's longer cooldown).

Trust: Ecowitt uploads and MQTT messages are unauthenticated, so a rule whose trigger or conditions
read such a device may not unlock, disarm or open a valve unless it is saved with
"allow_unsafe": true. Every automated unlock/disarm/open-valve also posts a notification.
Stored in /data/automations.json. Time-based rules use the NTP-corrected clock and the
configured timezone (app/timesync.py).
"""
from __future__ import annotations

import asyncio
import contextvars
import ipaddress
import json
import logging
import math
import os
import re
import socket
import time
import uuid
from urllib.parse import urlsplit
from collections import deque
from pathlib import Path
from typing import Any

from .security import redact

log = logging.getLogger("automations")

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
TRIGGER_OPS = {"changes", "becomes", "above", "below", "equals"}
MAX_DELAY = 3600
MAX_ACTIONS = 20
MAX_DEPTH = 3            # automation → command → automation … chains deeper than this are cut
CHAIN_WINDOW = 2.0       # seconds: a device change this soon after an automation's command counts as its result
MAX_CATCHUP_MIN = 15     # a stalled scheduler still fires time triggers missed within this many minutes
_depth: contextvars.ContextVar[int] = contextvars.ContextVar("automation_depth", default=0)
# True while a run belongs to a chain that started from an unauthenticated (Ecowitt/MQTT) device
_tainted: contextvars.ContextVar[bool] = contextvars.ContextVar("automation_tainted", default=False)
BLOCKED_MSG = "blocked: triggered by a chain that started from an unauthenticated sensor"
_BLOCKED_HOSTS = {ipaddress.ip_address("169.254.169.254"), ipaddress.ip_address("100.100.100.200"),
                  ipaddress.ip_address("fd00:ec2::254")}
MIN_DEVICE_COOLDOWN = 30      # seconds: floor on how often a device-triggered rule may run
LOW_TRUST_PREFIXES = ("ecowitt:", "mqtt:")      # unauthenticated sources (device.source ecowitt / mqtt)
# (capability, command value) pairs that weaken physical security
SECURITY_REDUCING = {("lock", "unlock"), ("alarm_panel", "disarm"), ("valve", "open"),
                     ("garage", "open"), ("garage_door", "open"), ("cover", "open")}
UNSAFE_MSG = ("This rule lets an unauthenticated sensor (Ecowitt/MQTT) unlock/disarm/open something "
              "— tick 'Allow anyway' to save it")


def is_low_trust(device_id: Any) -> bool:
    return str(device_id or "").startswith(LOW_TRUST_PREFIXES)


def is_security_reducing(act: dict) -> bool:
    if act.get("type") != "command":
        return False
    return (str(act.get("capability")), str(act.get("value")).strip().lower()) in SECURITY_REDUCING


def reads_low_trust(a: dict) -> bool:
    """Does a rule's trigger or any condition read an unauthenticated (Ecowitt/MQTT) device?"""
    t = a.get("trigger") or {}
    return (t.get("type") == "device" and is_low_trust(t.get("device_id"))) or \
        any(c.get("type") == "device" and is_low_trust(c.get("device_id")) for c in a.get("conditions") or [])


def unsafe_rule(a: dict) -> bool:
    """Does a (normalised) rule let a low-trust device trigger a security-reducing action?"""
    return reads_low_trust(a) and any(is_security_reducing(x) for x in a.get("actions") or [])


def effective_cooldown(a: dict) -> float:
    cd = a.get("cooldown") or 0
    if (a.get("trigger") or {}).get("type") == "device":
        return max(MIN_DEVICE_COOLDOWN, cd)
    return cd


# ---------------------------------------------------------------- value helpers
_TRUE = {"true", "on", "yes", "1", "open", "locked", "detected"}
_FALSE = {"false", "off", "no", "0", "closed", "unlocked", "clear"}


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _as_bool(v: Any) -> bool | None:
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    return True if s in _TRUE else False if s in _FALSE else None


def values_equal(actual: Any, wanted: Any) -> bool:
    if isinstance(actual, bool) or isinstance(wanted, bool):
        a, w = _as_bool(actual), _as_bool(wanted)
        if a is not None and w is not None:
            return a == w
    na, nw = _num(actual), _num(wanted)
    if na is not None and nw is not None:
        return na == nw
    return str(actual).strip().lower() == str(wanted).strip().lower()


def state_matches(op: str, value: Any, wanted: Any) -> bool:
    """Does the current value satisfy op/wanted? (used for conditions and trigger targets)"""
    if value is None:
        return False
    if op in ("becomes", "equals"):
        return values_equal(value, wanted)
    if op in ("above", "below"):
        a, w = _num(value), _num(wanted)
        if a is None or w is None:
            return False
        return a > w if op == "above" else a < w
    if op == "changes":
        return True
    return False


def trigger_fires(op: str, old: Any, new: Any, wanted: Any = None) -> bool:
    """Transition logic: fire only when the state *enters* the target."""
    if op == "changes":
        return old is not None and not values_equal(old, new)
    return state_matches(op, new, wanted) and not state_matches(op, old, wanted)


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


_own_cache: tuple[float, set] = (0.0, set())


def _own_addresses() -> set:
    """Best-effort list of this container's own interface addresses (cached for a minute)."""
    global _own_cache
    if time.monotonic() - _own_cache[0] < 60:
        return _own_cache[1]
    addrs: set = set()
    try:
        name = socket.gethostname()
        for info in socket.getaddrinfo(name, None):
            addrs.add(info[4][0].split("%")[0])
    except OSError:
        pass
    try:                                   # Linux: every interface's IPv4 address
        import fcntl
        import struct
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
            for _, ifname in socket.if_nameindex():
                try:
                    res = fcntl.ioctl(sk.fileno(), 0x8915, struct.pack("256s", ifname[:15].encode()))  # SIOCGIFADDR
                    addrs.add(socket.inet_ntoa(res[20:24]))
                except OSError:
                    pass
    except (ImportError, OSError, AttributeError):
        pass
    try:
        with open("/proc/net/if_inet6") as f:
            for line in f:
                h = line.split()[0]
                addrs.add(str(ipaddress.ip_address(bytes.fromhex(h))))
    except (OSError, ValueError, IndexError):
        pass
    out = set()
    for a in addrs:
        try:
            out.add(ipaddress.ip_address(a))
        except ValueError:
            pass
    _own_cache = (time.monotonic(), out)
    return out


def _own_ports() -> set[int]:
    ports = set()
    for var, default in (("HAVEN_PORT", "1701"), ("HAVEN_HTTPS_PORT", "1702")):
        try:
            p = int(os.environ.get(var) or default)
            if p:
                ports.add(p)
        except ValueError:
            pass
    return ports


async def check_webhook_url(url: str) -> list[str]:
    """Refuse webhooks to cloud-metadata, link-local and the container's own loopback addresses,
    and to Haven's own HTTP(S) port on any of this container's addresses. LAN addresses stay allowed
    (a webhook to another box at home is a normal use). Returns the vetted IP addresses: the caller
    must connect to one of these (not re-resolve the name, which could now point elsewhere)."""
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        raise ValueError("webhook URL has no host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as e:
        raise ValueError(f"bad port in webhook URL: {e}") from e
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None)
    except OSError as e:
        raise ValueError(f"can't resolve {host}: {e}") from e
    own, own_ports = _own_addresses(), _own_ports()
    ips: list[str] = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if ip in _BLOCKED_HOSTS or ip.is_link_local or ip.is_loopback or ip.is_multicast or ip.is_unspecified:
            raise ValueError(f"webhook to {host} ({ip}) is not allowed")
        if ip in own and port in own_ports:
            raise ValueError(f"webhook to Haven itself ({ip}:{port}) is not allowed")
        if str(ip) not in ips:
            ips.append(str(ip))
    if not ips:
        raise ValueError(f"can't resolve {host}")
    return ips


def pinned_request(url: str, ip: str) -> tuple[str, dict, dict]:
    """(url with the vetted IP as host, extra headers, httpx extensions): connect to exactly the
    address that was checked, while Host/SNI/certificate checks still use the real name."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    lit = f"[{ip}]" if ":" in ip else ip
    netloc = lit + (f":{parts.port}" if parts.port else "")
    pinned = parts._replace(netloc=netloc).geturl()
    host_hdr = (f"[{host}]" if ":" in host else host) + (f":{parts.port}" if parts.port else "")
    ext = {"sni_hostname": host} if parts.scheme == "https" else {}
    return pinned, {"Host": host_hdr}, ext


def _say(v: Any) -> str:
    """Human wording for log lines."""
    return "on" if v is True else "off" if v is False else str(v).replace("_", " ")


_HHMM = re.compile(r"([01]?[0-9]|2[0-3]):([0-5][0-9])")


def _hhmm(s: Any) -> int:
    """Minutes since midnight for "HH:MM" (00:00-23:59, "7:05" accepted). ValueError with a readable message."""
    m = _HHMM.fullmatch(s.strip()) if isinstance(s, str) else None
    if not m:
        shown = repr(s)[:20] if isinstance(s, str) else type(s).__name__
        raise ValueError(f"Time must be HH:MM between 00:00 and 23:59 (got {shown})")
    return int(m.group(1)) * 60 + int(m.group(2))


def norm_hhmm(s: Any) -> str:
    """Validate and zero-pad a time: "7:05" -> "07:05"."""
    n = _hhmm(s)
    return f"{n // 60:02d}:{n % 60:02d}"


def _url_secrets(urls) -> list[str]:
    """Parts of webhook URLs that must not appear in logs: the whole URL, its path and query (tokens often
    live in the path, e.g. https://hooks.example.com/services/T000/B000/XXXX)."""
    out = []
    for u in urls:
        if not u:
            continue
        p = urlsplit(str(u))
        tail = p.path + (f"?{p.query}" if p.query else "")
        out += [str(u), tail, p.path, p.query]
    return sorted({x for x in out if x and x != "/" and len(x) >= 4}, key=len, reverse=True)


def safe_url(u: str) -> str:
    """scheme://host[:port]/… for messages (never the path or query)."""
    p = urlsplit(str(u))
    return f"{p.scheme}://{p.netloc.rsplit('@', 1)[-1]}/…" if p.netloc else "…"


def in_window(minute_of_day: int, after: str | None, before: str | None) -> bool:
    a = _hhmm(after) if after else None
    b = _hhmm(before) if before else None
    if a is None and b is None:
        return True
    if a is None:
        return minute_of_day < b
    if b is None:
        return minute_of_day >= a
    if a <= b:
        return a <= minute_of_day < b
    return minute_of_day >= a or minute_of_day < b        # wraps past midnight


# ---------------------------------------------------------------- validation
def validate(a: dict, trust_check: bool = True) -> dict:
    """Normalize and check an automation; raises ValueError with a human message."""
    out = {"id": str(a.get("id") or uuid.uuid4().hex[:10])[:40], "name": str(a.get("name") or "Automation").strip()[:80],
           "enabled": bool(a.get("enabled", True)), "cooldown": min(7 * 86400, max(0, int(_num(a.get("cooldown")) or 0))),
           "last_run": a.get("last_run"), "run_count": int(a.get("run_count") or 0),
           "allow_unsafe": a.get("allow_unsafe") is True}
    t = dict(a.get("trigger") or {})
    kind = t.get("type")
    if kind == "device":
        if not t.get("device_id") or not t.get("capability"):
            raise ValueError("Pick a device and what to watch")
        op = t.get("op") or "changes"
        if op not in TRIGGER_OPS:
            raise ValueError(f"Unknown trigger condition {op}")
        if op in ("above", "below") and _num(t.get("value")) is None:
            raise ValueError("Above/below needs a number")
        if op in ("becomes", "equals") and _blank(t.get("value")):
            raise ValueError("Choose the value the device should become")
        out["trigger"] = {"type": "device", "device_id": str(t["device_id"]), "capability": str(t["capability"]), "op": op,
                          "value": t.get("value")}
    elif kind == "time":
        at = norm_hhmm(t.get("at"))
        days = [d for d in (t.get("days") or []) if d in DAYS] if isinstance(t.get("days"), list) else []
        out["trigger"] = {"type": "time", "at": at, "days": days}
    elif kind == "interval":
        mins = _num(t.get("minutes"))
        if not mins or mins < 1 or mins > 7 * 24 * 60:
            raise ValueError("Interval must be between 1 minute and 1 week")
        out["trigger"] = {"type": "interval", "minutes": mins}
    else:
        raise ValueError("Choose when the automation runs")
    conds = []
    for c in a.get("conditions") or []:
        ck = c.get("type")
        if ck == "device":
            if not c.get("device_id") or not c.get("capability"):
                raise ValueError("A condition is missing its device")
            cop = c.get("op") if c.get("op") in TRIGGER_OPS else "equals"
            if cop in ("becomes", "equals") and _blank(c.get("value")):
                raise ValueError("A condition is missing the value to compare with")
            if cop in ("above", "below") and _num(c.get("value")) is None:
                raise ValueError("Above/below needs a number")
            conds.append({"type": "device", "device_id": str(c["device_id"]), "capability": str(c["capability"]),
                          "op": cop, "value": c.get("value")})
        elif ck == "time":
            conds.append({"type": "time", "after": norm_hhmm(c["after"]) if c.get("after") else None,
                          "before": norm_hhmm(c["before"]) if c.get("before") else None})
        elif ck == "days":
            conds.append({"type": "days", "days": [d for d in (c.get("days") or []) if d in DAYS]})
        else:
            raise ValueError(f"Unknown condition {ck}")
    out["conditions"] = conds
    acts = []
    for x in (a.get("actions") or [])[:MAX_ACTIONS]:
        k = x.get("type")
        if k == "command":
            if not x.get("device_id") or not x.get("capability"):
                raise ValueError("A 'do' step is missing its device")
            if _blank(x.get("value")):
                raise ValueError("A 'do' step is missing the value to set")
            acts.append({"type": "command", "device_id": str(x["device_id"]), "capability": str(x["capability"]), "value": x.get("value")})
        elif k == "notify":
            acts.append({"type": "notify", "message": str(x.get("message") or "")[:500], "title": str(x.get("title") or "")[:80]})
        elif k == "delay":
            secs = _num(x.get("seconds"))
            if secs is None or secs < 0:
                raise ValueError("Wait needs a number of seconds")
            acts.append({"type": "delay", "seconds": min(MAX_DELAY, secs)})
        elif k == "webhook":
            url = str(x.get("url") or "")
            if not url.startswith(("http://", "https://")):
                raise ValueError("Webhook URL must start with http:// or https://")
            acts.append({"type": "webhook", "url": url, "method": "GET" if str(x.get("method")).upper() == "GET" else "POST",
                         "body": x.get("body")})
        else:
            raise ValueError(f"Unknown action {k}")
    if not acts:
        raise ValueError("Add at least one thing to do")
    out["actions"] = acts
    if trust_check and unsafe_rule(out) and not out["allow_unsafe"]:
        raise ValueError(UNSAFE_MSG)
    return out


# ---------------------------------------------------------------- engine
class AutomationEngine:
    def __init__(self, hub, clock, data_dir: Path) -> None:
        self.hub = hub
        self.clock = clock                    # app.timesync.TimeService (now(), tz)
        self.path = Path(data_dir) / "automations.json"
        self.items: dict[str, dict] = {}
        self.runs: deque = deque(maxlen=200)
        self.notifications: deque = deque(maxlen=100)
        self._last_fire: dict[str, float] = {}
        self._minute_key: dict[str, str] = {}
        self._interval_at: dict[str, float] = {}
        self._tasks: set[asyncio.Task] = set()
        self._running: dict[str, asyncio.Task] = {}          # one in-flight run per rule
        # device_id -> (time, depth, tainted) of an automation's command
        self._commanded: dict[str, tuple[float, int, bool]] = {}
        self._last_tick: float | None = None
        self._loop_task: asyncio.Task | None = None
        self.http = None                      # set lazily (httpx) for webhooks
        self.paused = False                   # HA standby: nothing runs here (app/ha.py)
        self.load()

    # ----- persistence -----
    def load(self) -> None:
        try:
            data = json.loads(self.path.read_text())
            for a in data.get("automations", []):
                try:
                    v = validate(a, trust_check=False)
                    if unsafe_rule(v) and not v["allow_unsafe"] and v["enabled"]:
                        # saved before the trust check existed: keep it, but don't let it run
                        log.warning("disabling automation %r: %s", v["name"], UNSAFE_MSG)
                        v["enabled"] = False
                    self.items[v["id"]] = v
                except ValueError as e:
                    log.warning("skipping invalid automation %s: %s", a.get("name"), e)
        except FileNotFoundError:
            pass
        except Exception as e:  # noqa: BLE001
            log.error("could not read %s: %s", self.path, e)

    def save(self) -> None:
        from .config import write_private      # webhook URLs can carry tokens
        write_private(self.path, json.dumps({"automations": list(self.items.values())}, indent=2, default=str))

    def upsert(self, data: dict) -> dict:
        prev = self.items.get(str(data.get("id"))) if data.get("id") else None
        if prev:
            data = {**data, "last_run": prev.get("last_run"), "run_count": prev.get("run_count", 0)}
        a = validate(data)
        self.items[a["id"]] = a
        self._interval_at.pop(a["id"], None)
        if not a["enabled"]:
            self._cancel(a["id"])
        self.save()
        return a

    def delete(self, aid: str) -> bool:
        if self.items.pop(aid, None) is None:
            return False
        self._cancel(aid)
        self.save()
        return True

    def _cancel(self, aid: str) -> None:
        """Stop an in-flight run (e.g. a pending 'wait, then unlock') of a deleted/disabled rule."""
        t = self._running.pop(aid, None)
        if t and not t.done():
            t.cancel()

    # ----- lifecycle -----
    async def start(self) -> None:
        if not self._loop_task:
            self._loop_task = asyncio.create_task(self._scheduler())

    async def stop(self) -> None:
        tasks = [t for t in [self._loop_task, *self._tasks] if t]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._loop_task = None
        self._tasks.clear()
        if self.http:
            await self.http.aclose()
            self.http = None

    def _spawn(self, coro) -> None:
        try:
            t = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:          # no loop (e.g. sync test) — run nothing
            coro.close()
            return
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        return t

    def start_run(self, aid: str, reason: str, force: bool = False, depth: int | None = None,
                  tainted: bool | None = None) -> None:
        """Start a run in the background unless one is already in flight for this rule."""
        a = self.items.get(aid)
        if not a:
            raise KeyError(aid)
        if self.paused:
            self._log({"automation": aid, "name": a["name"], "ts": self.clock.now(), "reason": reason, "ok": True,
                       "skipped": "this Haven is on standby (high availability)", "steps": []})
            return
        cur = self._running.get(aid)
        if cur and not cur.done():
            self._log({"automation": aid, "name": a["name"], "ts": self.clock.now(), "reason": reason, "ok": True,
                       "skipped": "already running", "steps": []})
            return
        d = _depth.get() if depth is None else depth
        if d >= MAX_DEPTH:
            self._log({"automation": aid, "name": a["name"], "ts": self.clock.now(), "reason": reason, "ok": True,
                       "skipped": "stopped a loop between automations", "steps": []})
            return
        ctx = contextvars.copy_context()
        ctx.run(_depth.set, d + 1)
        ctx.run(_tainted.set, _tainted.get() if tainted is None else bool(tainted))
        try:
            t = asyncio.get_running_loop().create_task(self.run(aid, reason, force), context=ctx)
        except RuntimeError:
            return
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        self._running[aid] = t
        t.add_done_callback(lambda _t, aid=aid: self._running.pop(aid, None) if self._running.get(aid) is _t else None)

    # ----- device events (called synchronously from Hub.set_values) -----
    def on_change(self, device_id: str, changes: dict[str, tuple[Any, Any]]) -> None:
        for a in list(self.items.values()):
            t = a["trigger"]
            if not a["enabled"] or t["type"] != "device" or t["device_id"] != device_id or t["capability"] not in changes:
                continue
            old, new = changes[t["capability"]]
            if trigger_fires(t["op"], old, new, t.get("value")):
                depth = _depth.get()
                tainted = _tainted.get() or is_low_trust(device_id)
                cmd = self._commanded.get(device_id)
                if cmd and time.monotonic() - cmd[0] < CHAIN_WINDOW:
                    depth = max(depth, cmd[1])         # this change was caused by an automation
                    tainted = tainted or cmd[2]        # ... whose chain started at an unauthenticated sensor
                self.start_run(a["id"], f"{self._dev_name(device_id)} {t['capability'].replace('_', ' ')} → {_say(new)}",
                               depth=depth, tainted=tainted)

    # ----- scheduler -----
    async def _scheduler(self) -> None:
        while True:
            try:
                self.tick(self.clock.now())
            except Exception as e:  # noqa: BLE001
                log.exception("scheduler tick failed: %s", e)
            await asyncio.sleep(5)

    def tick(self, now: float) -> list[str]:
        """Fire due time/interval automations. Returns ids fired (handy for tests)."""
        # every minute since the previous tick (so a stalled loop still fires what it missed), capped
        # (only minutes after the one the previous tick already covered, so a rule saved or enabled at
        # 08:01 for "08:00" doesn't fire late). Counted in real (UTC) minutes, so DST changes can't
        # repeat or invent minutes.
        cur_abs = now - (now % 60)
        stamps = [cur_abs]
        if self._last_tick is not None and now > self._last_tick:
            last_abs = self._last_tick - (self._last_tick % 60)
            back = min(MAX_CATCHUP_MIN, int((now - self._last_tick) // 60) + 1)
            stamps = [x for x in (cur_abs - 60 * i for i in range(back, 0, -1)) if x > last_abs] + [cur_abs]
        minutes = [(self.clock.local(x), self.clock.local(x - 60)) for x in stamps]   # (minute, the one before)
        self._last_tick = now
        fired = []
        for a in list(self.items.values()):
            if not a["enabled"]:
                continue
            t = a["trigger"]
            if t["type"] == "time":
                at = _hhmm(t["at"])
                for m, prev in minutes:
                    key = m.strftime("%Y-%m-%d ") + t["at"]      # once per day per time (also over DST fall-back)
                    mod, pmod = m.hour * 60 + m.minute, prev.hour * 60 + prev.minute
                    # spring forward: a time inside the skipped hour (02:30 when 02:00 jumps to 03:00) fires
                    # at the first minute after the gap
                    hit = mod == at or (prev.date() == m.date() and pmod < at < mod)
                    if hit and (not t["days"] or DAYS[m.weekday()] in t["days"]) \
                            and self._minute_key.get(a["id"]) != key:
                        self._minute_key[a["id"]] = key
                        fired.append(a["id"])
                        self.start_run(a["id"], f"scheduled at {t['at']}", depth=0, tainted=False)
                        break
            elif t["type"] == "interval":
                due = self._interval_at.setdefault(a["id"], now + t["minutes"] * 60)
                if now >= due:
                    self._interval_at[a["id"]] = now + t["minutes"] * 60
                    fired.append(a["id"])
                    self.start_run(a["id"], f"every {t['minutes']:g} min", depth=0, tainted=False)
        return fired

    # ----- conditions -----
    def conditions_pass(self, a: dict, now: float | None = None) -> tuple[bool, str]:
        local = self.clock.local(now)
        minute = local.hour * 60 + local.minute
        for c in a["conditions"]:
            if c["type"] == "time" and not in_window(minute, c.get("after"), c.get("before")):
                return False, f"outside {c.get('after') or '00:00'}–{c.get('before') or '24:00'}"
            if c["type"] == "days" and c["days"] and DAYS[local.weekday()] not in c["days"]:
                return False, "not on a selected day"
            if c["type"] == "device":
                dev = self.hub.devices.get(c["device_id"])
                cap = dev.capabilities.get(c["capability"]) if dev else None
                if not cap or not state_matches(c["op"], cap.value, c.get("value")):
                    return False, f"{self._dev_name(c['device_id'])} {c['capability']} is {cap.value if cap else 'unknown'}"
        return True, ""

    # ----- running -----
    def _dev_name(self, did: str) -> str:
        d = self.hub.devices.get(did)
        return d.name if d else did

    async def run(self, aid: str, reason: str, force: bool = False) -> dict:
        a = self.items.get(aid)
        if not a:
            raise KeyError(aid)
        now = self.clock.now()
        entry = {"automation": aid, "name": a["name"], "ts": now, "reason": reason, "ok": True, "skipped": None, "steps": []}
        if not force:
            cooldown = effective_cooldown(a)
            if cooldown and now - self._last_fire.get(aid, 0) < cooldown:
                entry.update(ok=True, skipped="cooldown")
                self._log(entry)
                return entry
            ok, why = self.conditions_pass(a, now)
            if not ok:
                entry.update(skipped=why)
                self._log(entry)
                return entry
        self._last_fire[aid] = now
        # A run is tainted when it was set off (directly or through other automations' commands) by an
        # unauthenticated device, or when this rule itself reads one. Commands it sends carry the taint on.
        tainted = _tainted.get() or (not force and reads_low_trust(a))
        _tainted.set(tainted)            # this task's own context copy
        secrets = _url_secrets(x.get("url") for x in a["actions"] if x.get("type") == "webhook")
        for act in a["actions"]:
            if tainted and is_security_reducing(act) and not a.get("allow_unsafe"):
                what = f"{self._dev_name(act['device_id'])}: {act['capability'].replace('_', ' ')} → {_say(act['value'])}"
                log.warning("automation %r: %s — %s (%s)", a["name"], what, BLOCKED_MSG, reason)
                self.notify(f"Automation: {a['name']}", f"{what} {BLOCKED_MSG}")
                entry["ok"] = False
                entry["steps"].append(f"{what} {BLOCKED_MSG}")
                break
            try:
                entry["steps"].append(redact(await self._do(act, a), secrets))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                entry["ok"] = False
                entry["steps"].append(f"failed: {redact(e, secrets)}")
                break
        cur = self.items.get(aid) or a          # the rule may have been edited while it ran
        cur["last_run"] = now
        cur["run_count"] = cur.get("run_count", 0) + 1
        try:
            self.save()
        except OSError as e:
            log.warning("could not save automations: %s", e)
        self._log(entry)
        return entry

    async def _do(self, act: dict, a: dict) -> str:
        k = act["type"]
        if k == "command":
            self._commanded[act["device_id"]] = (time.monotonic(), _depth.get(), _tainted.get())
            what = f"{self._dev_name(act['device_id'])}: {act['capability'].replace('_', ' ')} → {_say(act['value'])}"
            if not is_security_reducing(act):
                await self.hub.command(act["device_id"], act["capability"], act["value"])
                return what
            try:
                await self.hub.command(act["device_id"], act["capability"], act["value"])
            except Exception as e:
                self.notify(f"Automation: {a['name']}", f"Tried {what} — failed: {e}")
                raise
            self.notify(f"Automation: {a['name']}", what)     # every automated unlock/disarm/open is reported
            return what
        if k == "notify":
            self.notify(act.get("title") or a["name"], act["message"])
            return f"notified: {act['message']}"
        if k == "delay":
            await asyncio.sleep(act["seconds"])
            return f"waited {act['seconds']:g}s"
        if k == "webhook":
            import httpx
            ips = await check_webhook_url(act["url"])
            if self.http is None:
                self.http = httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False)
            body = act.get("body") or {"automation": a["name"], "ts": self.clock.now()}
            url, headers, ext = pinned_request(act["url"], ips[0])     # connect to the address we vetted
            if act["method"] == "GET":
                r = await self.http.request("GET", url, headers=headers, extensions=ext)
            else:
                r = await self.http.request("POST", url, headers=headers, json=body, extensions=ext)
            if r.is_error:      # httpx's own message contains the full URL (tokens): say it without the URL
                raise RuntimeError(f"webhook {act['method']} {safe_url(act['url'])} answered {r.status_code}")
            return f"webhook {act['method']} {r.status_code}"
        raise ValueError(k)

    def notify(self, title: str, message: str) -> dict:
        n = {"type": "notification", "title": title, "message": message, "ts": self.clock.now()}
        self.notifications.appendleft(n)
        broadcast = getattr(self.hub, "broadcast", None)
        if broadcast:
            broadcast(n)
        return n

    def _log(self, entry: dict) -> None:
        entry["steps"] = [redact(x) for x in entry["steps"]]      # no ?token=… in the run log or container log
        self.runs.appendleft(entry)
        lvl = logging.INFO if entry["ok"] else logging.WARNING
        log.log(lvl, "%s (%s): %s", entry["name"], entry["reason"], entry["skipped"] or "; ".join(entry["steps"]))
