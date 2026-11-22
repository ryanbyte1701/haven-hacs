"""Anonymous diagnostics ("tech dump") for troubleshooting: what each device is and what it reports, which
integrations are on and how they're doing, plus recent warnings. Nothing that identifies the home or its people:

- device and room names are replaced (Thermostat 1, Room A …), ids and Home Assistant entity ids are hashed
  with a salt that is new for every dump;
- free text (status lines, log lines, text readings) has IP and MAC addresses, e-mail addresses, URLs' hosts,
  long tokens and the integrations' stored secrets removed;
- settings are listed as "which fields are filled in", never their values.

What stays: device types, makes/models, integration names, capability names, numeric/boolean/state readings,
units, ranges, which ones are controllable, how long ago each was updated, online/battery state, the Haven
edition and versions, the history backend and its size.
"""
from __future__ import annotations

import collections
import hashlib
import logging
import os
import platform
import re
import secrets
import sys
import time
from typing import Any

from . import security as sec
from .models import UNITS

# ---------------------------------------------------------------- recent warnings (ring buffer)
_RECENT: collections.deque = collections.deque(maxlen=300)


class _Ring(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            _RECENT.append((record.created, record.levelname, record.name, record.getMessage()[:600]))
        except Exception:  # noqa: BLE001 - never let diagnostics break logging
            pass


def install_log_buffer() -> None:
    root = logging.getLogger()
    if not any(isinstance(h, _Ring) for h in root.handlers):
        h = _Ring(level=logging.WARNING)
        root.addHandler(h)


# ---------------------------------------------------------------- scrubbing
_IP4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IP6 = re.compile(r"\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b", re.I)
_IP6_SHORT = re.compile(r"(?<![\w:])(?:[0-9a-f]{0,4}:){1,7}:[0-9a-f]{0,4}(?::[0-9a-f]{1,4}){0,6}(?![\w:])", re.I)   # with ::
_MAC = re.compile(r"\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b", re.I)
_MAC_PLAIN = re.compile(r"\b(?=[0-9a-f]*[a-f])[0-9a-f]{12}\b", re.I)
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_URL = re.compile(r"\b(https?|wss?|mqtt|sftp|ftp)://[^\s'\"<>]*", re.I)             # the host and the path after it
_HOST_PORT = re.compile(r"\b(?=[a-z0-9.-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}\b", re.I)
_HOSTNAME = re.compile(r"\b(?:[a-z0-9-]+\.)+(?:local|lan|home|internal|localdomain|arpa|net|com|org|io|me|tv|cc|xyz|info|us|dev|app|cloud)\b", re.I)
_LONG = re.compile(r"\b[A-Za-z0-9_\-]{20,}\b")        # tokens, keys, serial-like ids


_KEEP = re.compile(r"Home Assistant|Haven|HomeKit|ESPHome|SmartThings|Google Home|Apple Home", re.I)


def scrub(text: Any, secrets_: list[str] = (), names: dict[str, str] | None = None) -> str:
    """Remove what identifies the home. `names` maps the real device names, ids and rooms to their pseudonyms."""
    s = sec.redact(str(text), secrets_)
    if names:
        keys = sorted((k for k in names if len(k) >= 3), key=len, reverse=True)
        if keys:
            # product names a room or device may share a word with ("Home" in Home Assistant) are kept
            kept: list[str] = []
            s = _KEEP.sub(lambda m: kept.append(m.group(0)) or f"\x00{len(kept) - 1}\x00", s)
            s = re.sub(r"(?<![\w])(?:" + "|".join(re.escape(k) for k in keys) + r")(?![\w])", lambda m: names[m.group(0)], s)   # whole words only
            s = re.sub(r"\x00(\d+)\x00", lambda m: kept[int(m.group(1))], s)
    s = _URL.sub(lambda m: f"{m.group(1)}://<host>", s)
    s = _EMAIL.sub("<email>", s)
    s = _MAC.sub("<mac>", s)
    s = _MAC_PLAIN.sub("<mac>", s)
    s = _IP6.sub("<ip>", s)
    s = _IP6_SHORT.sub("<ip>", s)
    s = _IP4.sub("<ip>", s)
    s = _HOST_PORT.sub("<host>", s)
    s = _HOSTNAME.sub("<host>", s)
    s = _LONG.sub("<id>", s)
    return s


class _Anon:
    """Consistent pseudonyms within one dump."""

    def __init__(self) -> None:
        self.salt = secrets.token_hex(8)
        self.rooms: dict[str, str] = {}
        self.counts: collections.Counter = collections.Counter()

    def hid(self, prefix: str, value: Any) -> str:
        return f"{prefix}-{hashlib.sha256((self.salt + str(value)).encode()).hexdigest()[:8]}"

    def room(self, name: str | None) -> str | None:
        if not name:
            return None
        if name not in self.rooms:
            n = len(self.rooms)
            self.rooms[name] = "Room " + (chr(65 + n) if n < 26 else str(n + 1))
        return self.rooms[name]

    def name(self, kind: str) -> str:
        self.counts[kind] += 1
        return f"{kind.replace('_', ' ').capitalize()} {self.counts[kind]}"


def _value(v: Any, secrets_: list[str]) -> Any:
    """Readings: numbers, booleans and short lowercase state words (open, on_battery) stay; other text (it may be a
    name) is described, not copied."""
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, str):
        if len(v) <= 32 and re.fullmatch(r"[a-z0-9_ .:%+\-/#°]*", v) and not _IP4.search(v) and not _EMAIL.search(v):
            return v if not v.startswith("#") else "<colour>"
        return f"<text, {len(v)} chars>"
    if isinstance(v, (list, tuple)):
        return f"<list, {len(v)} items>"
    if isinstance(v, dict):
        return f"<object, {len(v)} keys>"
    return f"<{type(v).__name__}>"


_ATTR_KEEP = {"kind", "icon", "is_day", "yolink_type", "hvac_modes", "fan_modes", "has_snapshot", "via"}


_CAP_BASES = sorted({*UNITS, "light", "switch", "lock", "valve", "contact", "leak", "motion", "occupancy", "smoke", "co", "gas",
                     "heat", "battery_low", "tamper", "vibration", "power_on", "connected", "state", "value", "action", "position",
                     "shade", "brightness", "color", "color_temp", "fan_speed", "alarm_panel", "hvac_mode", "hvac_action",
                     "fan_mode", "target_temperature", "heat_setpoint", "cool_setpoint", "status_text", "opening", "energy_today",
                     "energy_month", "energy_total", "co_ppm", "ups_status"}, key=len, reverse=True)


def _cap_key(name: str, anon: _Anon) -> str:
    """Capability names are kept when they are Haven's own. A suffix that came from a Home Assistant entity or
    friendly name (switch_<name>, value_<entity>) is replaced with a hash."""
    if name in _CAP_BASES:
        return name
    for base in _CAP_BASES:
        if name.startswith(base + "_"):
            return f"{base}_{anon.hid('x', name)[2:]}"
    return anon.hid("cap", name)


def _device(d, anon: _Anon, now: float, secrets_: list[str]) -> dict:
    attrs = d.attributes or {}
    keys = {name: _cap_key(name, anon) for name in d.capabilities}
    kind = str(attrs.get("kind") or next(iter(keys.values()), "device"))
    caps = {}
    for name, c in d.capabilities.items():
        entry = {"value": _value(c.value, secrets_)}
        for k in ("unit", "min", "max", "step", "options", "writable"):      # not the label: it is often a friendly name
            v = getattr(c, k, None)
            if v not in (None, False, "", []):
                entry[k] = v
        if getattr(c, "updated", None):
            entry["age_s"] = round(now - c.updated)
        caps[keys[name]] = entry
    out = {
        "id": anon.hid("dev", d.id),
        "name": anon.name(kind),
        "source": d.source,
        "model": scrub(d.model, secrets_) if d.model else None,
        "room": anon.room(d.room),
        "online": d.online,
        "hidden": bool(getattr(d, "hidden", False)),
        "capabilities": caps,
        "attributes": {k: (_value(v, secrets_) if k not in ("hvac_modes", "fan_modes") else v)
                       for k, v in attrs.items() if k in _ATTR_KEEP},
        "attribute_keys": sorted(k for k in attrs if k not in _ATTR_KEEP),
    }
    if attrs.get("ha_entities"):
        out["ha_entities"] = [f"{str(e).split('.', 1)[0]}.{anon.hid('e', e)[2:]}" for e in attrs["ha_entities"]]
    if attrs.get("members"):
        out["group_members"] = len(attrs["members"])
    return out


def _settings(settings_mod, statuses: dict, secrets_: list[str], names: dict[str, str] | None = None) -> list[dict]:
    out = []
    try:
        cfg = settings_mod.effective_config()
        for s in settings_mod.public_view(cfg, statuses):
            vals = s.get("values") or {}
            out.append({
                "id": s["id"], "enabled": bool(s.get("enabled")),
                "status": scrub(s.get("status"), secrets_, names) if s.get("status") else None,
                "fields_set": sorted(k for k, v in vals.items() if v not in (None, "", [], {}, False)),
            })
    except Exception as e:  # noqa: BLE001
        out.append({"error": scrub(f"{type(e).__name__}: {e}", secrets_)})
    return out


def _version() -> str | None:
    v = os.getenv("HAVEN_VERSION")
    if v:
        return v
    try:
        import json
        from pathlib import Path
        m = Path(__file__).resolve().parents[1] / "manifest.json"      # Home Assistant edition: the integration's
        if m.exists():
            return json.loads(m.read_text()).get("version")
    except Exception:  # noqa: BLE001
        pass
    return None


_DASH_WORDS = re.compile(r"[a-z0-9_ .:%+\-/#°×]{0,40}", re.I)


def _dash_value(v: Any, names: dict[str, str], depth: int = 0) -> Any:
    """What the browser sent about its dashboard, kept only as numbers, booleans and short words (no free text)."""
    if depth > 5:
        return None
    if isinstance(v, bool) or v is None or isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = scrub(v[:60], (), names)
        return s if _DASH_WORDS.fullmatch(s) else "<text>"
    if isinstance(v, list):
        return [_dash_value(x, names, depth + 1) for x in v[:500]]
    if isinstance(v, dict):
        return {str(k)[:40]: _dash_value(x, names, depth + 1) for k, x in list(v.items())[:500] if _DASH_WORDS.fullmatch(str(k))}
    return None


def _dashboard(client: Any, ids: dict[str, str], names: dict[str, str]) -> dict | None:
    """The browser's view of the dashboard: screen, appearance choices, every page with what is on it, and per
    device its type, pages and how its card fits. Device ids become the file's pseudonyms; anything else is dropped."""
    if not isinstance(client, dict):
        return None
    out = {k: _dash_value(client[k], names) for k in ("screen", "prefs", "pages", "views", "layout", "types") if k in client}
    devs = client.get("devices")
    if isinstance(devs, dict):
        out["devices"] = {ids[k]: _dash_value(v, names) for k, v in devs.items() if k in ids and isinstance(v, dict)}
    return out


def build(hub, manager, history_store, settings_mod, *, extra: dict | None = None, client: Any = None) -> dict:
    """The whole dump as a JSON-able dict."""
    from . import edition
    now = time.time()
    secrets_ = list(manager.secrets()) if manager else []
    anon = _Anon()
    ordered = sorted(hub.devices.values(), key=lambda d: (d.source, d.id))
    devs = [_device(d, anon, now, secrets_) for d in ordered]
    names: dict[str, str] = {}              # what appears in log and status lines -> its pseudonym
    for d, out in zip(ordered, devs, strict=True):
        names[d.name] = out["name"]
        names[d.id] = out["id"]
        if d.room:
            names[d.room] = anon.room(d.room) or ""
    by_source = collections.Counter(d["source"] for d in devs)
    statuses = manager.statuses() if manager else {}
    hist = {}
    try:
        hist = {"backend": history_store.store.name, "status": scrub(history_store.status, secrets_)}
        info = history_store.info()
        hist.update({k: info[k] for k in ("ranges", "retention_days", "size_bytes", "devices", "oldest") if k in info})
    except Exception as e:  # noqa: BLE001
        hist = {"error": scrub(e, secrets_)}
    from . import config as config_mod
    return {
        "about": "Haven diagnostics. Names, rooms, addresses and ids are anonymised; readings and device types are kept.",
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "haven": {
            "edition": "home-assistant" if edition.HACS else "og",
            "version": _version(),
            "python": sys.version.split()[0],
            "platform": f"{platform.system()} {platform.machine()}",
            "time_zone": os.getenv("TZ"),
            "storage_problem": scrub(config_mod.STORAGE_PROBLEM, secrets_) if config_mod.STORAGE_PROBLEM else None,
        },
        "summary": {
            "devices": len(devs),
            "offline": sum(1 for d in devs if not d["online"]),
            "by_integration": dict(sorted(by_source.items())),
            "rooms": len(anon.rooms),
        },
        "integrations": {k: scrub(v, secrets_, names) for k, v in sorted(statuses.items())},
        "dashboard": _dashboard(client, {d.id: out["id"] for d, out in zip(ordered, devs, strict=True)}, names),
        "settings": _settings(settings_mod, statuses, secrets_, names),
        "history": hist,
        **(extra or {}),
        "devices": devs,
        "recent_warnings": [
            {"age_s": round(now - t), "level": lvl, "logger": name, "message": scrub(msg, secrets_, names)}
            for t, lvl, name, msg in list(_RECENT)[-150:]
        ],
    }
