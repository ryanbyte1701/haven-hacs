"""Central state store: holds devices, routes commands to adapters, fans out updates."""
from __future__ import annotations

import asyncio
import re
import json
import secrets
import logging
import math
import time
from collections import deque
from typing import Any

from starlette.exceptions import HTTPException

from .config import conf_dir
from .models import Capability, Device

log = logging.getLogger("hub")

HISTORY_POINTS = 288      # 24h at 5-minute resolution
STATE_HISTORY_POINTS = 2000   # state changes kept in memory per capability
HISTORY_INTERVAL = 300
RECENT_SECONDS = 600      # every numeric reading of the last 10 minutes (the device panel's live "Now" charts)
RECENT_POINTS = 3000      # per capability, a bound for chatty devices
CLOSE = object()          # sentinel put on a subscriber queue: "this client fell behind, close it"


def _finite(v: Any) -> bool:
    return not (isinstance(v, float) and not math.isfinite(v))


_VIEW_ID = re.compile(r"[A-Za-z0-9_-]{1,40}")


def _clean_view(v: dict) -> dict:
    """A custom view: name + icon + rules. A device matches if hand-picked, or if it passes every
    non-empty rule (rooms, types, sources). Anything of the wrong type is dropped, never a 500."""
    def lst(k, n=200):
        val = v.get(k)
        if not isinstance(val, list):
            return []
        return [str(x)[:200] for x in val if isinstance(x, (str, int, float)) and not isinstance(x, bool)][:n]

    def text(k, default):
        val = v.get(k)
        return val[:40] if isinstance(val, str) and val.strip() else default

    vid = v.get("id")
    vid = str(vid) if isinstance(vid, (str, int)) and not isinstance(vid, bool) else ""
    if not _VIEW_ID.fullmatch(vid):      # ids end up in URLs and element ids: keep them to a safe alphabet
        vid = "v" + secrets.token_hex(6)
    return {"id": vid, "name": text("name", "View"), "icon": text("icon", "dashboard"),
            "rooms": lst("rooms"), "types": lst("types", 20), "sources": lst("sources", 20), "devices": lst("devices")}


def _write_json(path, data) -> None:
    """Write a JSON file atomically (temp file + rename): a crash or full disk never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(path)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


class SaveError(HTTPException):
    """A dashboard setting could not be written to /data (full disk, read-only mount, permissions).
    An HTTPException so the API answers 503 with this message instead of a bare 500."""

    def __init__(self, detail: str) -> None:
        super().__init__(503, detail)


_SAFE_CAP = re.compile(r"[A-Za-z0-9_]{1,64}")


HOME_FLAGS = ("weather", "station", "climate", "aqi_outdoor", "aqi_indoor", "forecast", "favorites", "rooms", "greeting")


def _clean_home(h) -> dict | None:
    """Home page choices: which top cards show, and which status tiles in which order."""
    if not isinstance(h, dict):
        return None
    out = {k: bool(h[k]) for k in HOME_FLAGS if k in h}
    if isinstance(h.get("tiles"), list):
        out["tiles"] = [str(t)[:40] for t in h["tiles"] if isinstance(t, str)][:30]
    if isinstance(h.get("hidden_pages"), list):
        out["hidden_pages"] = [str(t)[:40] for t in h["hidden_pages"] if isinstance(t, str)][:30]
    for k, n in (("title", 40), ("start", 40), ("density", 12)):
        if isinstance(h.get(k), str):
            out[k] = h[k].strip()[:n]
    return out


class Hub:
    def __init__(self) -> None:
        self.devices: dict[str, Device] = {}
        self.adapters: dict[str, Any] = {}
        self.history: dict[tuple[str, str], deque] = {}
        # on/off and text states (door, lock, light, UPS status…): every change, for state timelines
        self.state_history: dict[tuple[str, str], deque] = {}
        # every numeric reading of the last RECENT_SECONDS, not thinned to 5 minutes (live charts)
        self.recent: dict[tuple[str, str], deque] = {}
        self.recorder: Any = None   # app.history.History, set at startup (persistent storage)
        # Callables(device_id, {capability: (old, new)}) run on every value change (e.g. automations).
        self.listeners: list = []
        self._nonfinite_logged: set = set()
        self._subs: set[asyncio.Queue] = set()
        self._overrides_path = conf_dir() / "overrides.json"
        self.overrides: dict[str, dict] = self._load_overrides()
        self._layout_path = conf_dir() / "layout.json"
        self.layout: dict = self._load_layout()

    # ---------- persistence of user edits (name / room / hidden) ----------
    def _load_overrides(self) -> dict:
        try:
            return json.loads(self._overrides_path.read_text())
        except Exception:
            return {}

    # ---------- dashboard layout (room order, device order, favorites) ----------
    def _load_layout(self) -> dict:
        try:
            data = json.loads(self._layout_path.read_text())
            return {"rooms": list(data.get("rooms", [])), "order": dict(data.get("order", {})),
                    "pinned": list(data.get("pinned", [])), "views": list(data.get("views", []))}
        except Exception:
            return {"rooms": [], "order": {}, "pinned": [], "views": []}

    def set_layout(self, layout: dict) -> dict:
        """Update the layout. Keys that are absent (or None) keep their current value, so a
        partial update (e.g. "reset order") can't wipe custom views."""
        cur = self.layout
        get = lambda k: layout.get(k) if layout.get(k) is not None else cur.get(k)  # noqa: E731
        clean = {
            "rooms": [str(r)[:80] for r in (get("rooms") or [])][:200],
            "order": {str(r)[:80]: [str(i)[:200] for i in ids][:500]
                      for r, ids in list((get("order") or {}).items())[:200] if isinstance(ids, list)},
            "pinned": [str(i)[:200] for i in (get("pinned") or [])][:100],
            "views": [_clean_view(v) for v in (get("views") or [])[:30] if isinstance(v, dict) and v.get("id")],
        }
        home = _clean_home(get("home"))
        if home is not None:
            clean["home"] = home
        self.layout = clean
        self.broadcast({"type": "layout", "layout": clean})
        try:
            _write_json(self._layout_path, clean)
        except OSError as e:
            log.error("could not save %s: %s", self._layout_path, e)
            raise SaveError(f"The layout is changed until restart but could not be saved: {e.strerror or e}") from e
        return clean

    def set_override(self, device_id: str, **fields) -> Device | None:
        if device_id not in self.devices and device_id not in self.overrides:
            return None                      # unknown device: don't grow overrides.json
        for k in ("name", "room"):
            if isinstance(fields.get(k), str):
                fields[k] = fields[k][:80]
        o = self.overrides.setdefault(device_id, {})
        if fields.pop("auto_categories", None):
            o.pop("categories", None)
        o.update({k: v for k, v in fields.items() if v is not None})
        dev = self.devices.get(device_id)
        if dev:
            self._apply_overrides(dev)
            self._publish(dev)
        try:
            _write_json(self._overrides_path, self.overrides)
        except OSError as e:
            log.error("could not save %s: %s", self._overrides_path, e)
            raise SaveError(f"The change applies until restart but could not be saved: {e.strerror or e}") from e
        return dev

    def _apply_overrides(self, dev: Device) -> None:
        for k, v in self.overrides.get(dev.id, {}).items():
            if k in ("name", "room", "hidden"):
                setattr(dev, k, v)
        dev.categories = self.overrides.get(dev.id, {}).get("categories")

    # ---------- adapter-facing API ----------
    def upsert_device(self, dev: Device) -> None:
        # capability names end up in HTML attributes and URLs: keep them to a safe alphabet
        bad = [k for k in dev.capabilities if not _SAFE_CAP.fullmatch(k)]
        for k in bad:
            log.warning("ignoring capability %r on %s (unsupported characters)", k[:40], dev.id)
            dev.capabilities.pop(k)
        old = self.devices.get(dev.id)
        if old:
            for k, c in dev.capabilities.items():
                if c.value is None and k in old.capabilities:
                    c.value = old.capabilities[k].value
                    c.updated = old.capabilities[k].updated
            for k, c in old.capabilities.items():
                dev.capabilities.setdefault(k, c)
            if not dev.room:
                dev.room = old.room
        self._apply_overrides(dev)
        self.devices[dev.id] = dev
        self._publish(dev)

    def set_values(self, device_id: str, values: dict[str, Any], online: bool | None = True) -> None:
        dev = self.devices.get(device_id)
        if not dev:
            return
        now = time.time()
        changes: dict[str, tuple[Any, Any]] = {}
        for k, v in values.items():
            if v is None:
                continue
            if not _finite(v):
                if (device_id, k) not in self._nonfinite_logged:
                    self._nonfinite_logged.add((device_id, k))
                    log.warning("ignoring non-numeric value %r for %s.%s", v, device_id, k)
                continue
            c = dev.capabilities.get(k)
            if c is None:
                c = dev.capabilities[k] = Capability(name=k)
            if c.value != v:
                changes[k] = (c.value, v)
            c.value = v
            c.updated = now
            self._record(device_id, k, v, now)
        dev.last_seen = now
        if online is not None:
            dev.online = online
        self._publish(dev)
        if changes:
            for fn in list(self.listeners):
                try:
                    fn(device_id, changes)
                except Exception as e:  # noqa: BLE001 - a listener must never break device updates
                    log.warning("listener failed: %s", e)

    def broadcast(self, msg: dict) -> None:
        """Send an arbitrary message (e.g. a notification) to every connected browser."""
        for q in list(self._subs):
            self._offer(q, msg)

    def _offer(self, q: asyncio.Queue, msg) -> None:
        """Queue a message; a client that has fallen 500 messages behind is told to close so it
        reconnects and gets a fresh snapshot instead of silently missing updates."""
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            self._subs.discard(q)
            try:
                q.get_nowait()
                q.put_nowait(CLOSE)
            except (asyncio.QueueEmpty, asyncio.QueueFull):
                pass

    def remove_source(self, source: str) -> None:
        """Drop all devices from an integration that was turned off."""
        for did in [d.id for d in self.devices.values() if d.source == source]:
            self.devices.pop(did, None)
            self.broadcast({"type": "remove", "id": did})

    def remove_device(self, device_id: str) -> None:
        if self.devices.pop(device_id, None) is not None:
            self.broadcast({"type": "remove", "id": device_id})

    def set_attributes(self, device_id: str, attrs: dict[str, Any], publish: bool = False) -> None:
        dev = self.devices.get(device_id)
        if dev:
            dev.attributes.update(attrs)
            if publish:
                self._publish(dev)

    def _record(self, device_id: str, cap_name: str, v: Any, now: float) -> None:
        if self.recorder is not None:
            self.recorder.record(device_id, cap_name, v, now)
        from .history import to_number
        conv = to_number(cap_name, v)
        if conv is not None and conv[1]:
            sb = self.state_history.setdefault((device_id, cap_name), deque(maxlen=STATE_HISTORY_POINTS))
            if not sb or sb[-1][1] != conv[0]:
                sb.append((now, conv[0]))
            return
        if conv is None or isinstance(v, bool) or not isinstance(v, (int, float)):
            return       # not a number (or an int too large for a float: OverflowError later)
        rec = self.recent.setdefault((device_id, cap_name), deque(maxlen=RECENT_POINTS))
        rec.append((now, v))
        while rec and rec[0][0] < now - RECENT_SECONDS:
            rec.popleft()
        buf = self.history.setdefault((device_id, cap_name), deque(maxlen=HISTORY_POINTS))
        if buf and now - buf[-1][0] < HISTORY_INTERVAL:
            buf[-1] = (buf[-1][0], v)   # keep latest value within the bucket
        else:
            buf.append((now, v))

    # ---------- commands ----------
    async def command(self, device_id: str, capability: str, value: Any) -> None:
        dev = self.devices.get(device_id)
        if not dev:
            raise KeyError(f"unknown device {device_id}")
        c = dev.capabilities.get(capability)
        if not c or not c.writable:
            raise ValueError(f"{capability} is not controllable on {dev.name}")
        if c.options and value not in c.options:
            raise ValueError(f"value must be one of {c.options}")
        adapter = self.adapters.get(dev.source)
        if not adapter:
            raise RuntimeError(f"adapter {dev.source} not running")
        log.info("command %s %s=%s", device_id, capability, value)
        await adapter.command(dev, capability, value)

    # ---------- live updates ----------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def _publish(self, dev: Device) -> None:
        self.broadcast({"type": "device", "device": dev.model_dump()})
