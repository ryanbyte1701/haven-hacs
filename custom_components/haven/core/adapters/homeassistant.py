"""Home Assistant: import entities from an existing Home Assistant and control them through it.

Connects to Home Assistant's WebSocket API (http(s)://host:8123/api/websocket) with a long-lived
access token (Home Assistant > your profile > Security > Long-lived access tokens):

- reads the area, device and entity registries once, then every entity's state;
- groups entities by their Home Assistant device, so one Haven card = one HA device, in its HA area;
- subscribes to state_changed for live updates;
- sends controls back as Home Assistant service calls (lock.lock, light.turn_on, valve.open_valve, ...).

Only entity types Haven understands are imported (sensors, binary sensors, lights, switches, locks,
valves, covers, alarm panels, fans, climate readings, weather). Hidden, disabled and
configuration/diagnostic entities are skipped (battery level is kept).

Devices that Home Assistant gets from an integration Haven also connects to directly (YoLink, Hue, Tapo,
MQTT, Matter, ...; see NATIVE) are skipped too, whether or not that Haven integration is turned on, so a
device never shows up twice. "Also import devices from integrations Haven connects to directly" turns
that off.
"""
from __future__ import annotations

import asyncio
import fnmatch
import json
import math
import re
from typing import Any

from ..models import Device, cap
from .base import Adapter

DOMAINS = ["sensor", "binary_sensor", "light", "switch", "input_boolean", "lock", "valve", "cover",
           "alarm_control_panel", "fan", "climate", "weather"]

BINARY = {   # binary_sensor device_class -> (capability, on value, off value)
    "door": ("contact", "open", "closed"), "window": ("contact", "open", "closed"), "garage_door": ("contact", "open", "closed"),
    "opening": ("contact", "open", "closed"), "moisture": ("leak", True, False), "motion": ("motion", True, False),
    "occupancy": ("occupancy", True, False), "presence": ("occupancy", True, False), "smoke": ("smoke", True, False),
    "carbon_monoxide": ("co", True, False), "gas": ("gas", True, False), "heat": ("heat", True, False),
    "battery": ("battery_low", True, False), "tamper": ("tamper", True, False), "vibration": ("vibration", True, False),
    "plug": ("switch", True, False), "power": ("power_on", True, False), "connectivity": ("connected", True, False),
}
SENSOR = {   # sensor device_class -> capability
    "temperature": "temperature", "humidity": "humidity", "battery": "battery", "power": "power", "energy": "energy_total",
    "voltage": "voltage", "current": "current", "pm25": "pm25", "pm10": "pm10", "carbon_dioxide": "co2",
    "volatile_organic_compounds": "voc", "volatile_organic_compounds_parts": "voc", "aqi": "aqi", "illuminance": "illuminance",
    "pressure": "pressure", "atmospheric_pressure": "pressure", "moisture": "moisture", "carbon_monoxide": "co_ppm",
    "wind_speed": "wind_speed", "precipitation": "rain_daily", "precipitation_intensity": "rain_rate", "irradiance": "solar",
    "water": "water_usage_today", "volume_flow_rate": "flow_rate", "signal_strength": "rssi",
}
SKIP_CATEGORIES = {"config", "diagnostic"}

# Home Assistant integration domain -> the Haven integration (Settings section label) that covers it.
# Core integrations are in home-assistant/core homeassistant/components/<domain>; custom (HACS) ones
# are named by the "domain" in their manifest.json.
NATIVE = {
    "yolink": "YoLink",
    "ecobee": "Ecobee",
    "aqara_bridge": "Aqara", "aqara_gateway": "Aqara", "xiaomi_aqara": "Aqara",   # Aqara cloud / hub (custom, custom, core)
    "ecowitt": "Ecowitt",
    "xsense": "X-Sense",                               # custom: Jarnsen/ha-xsense-component_test, javaDevJT/ha-xsense-home
    "ring": "Ring",
    "hue": "Philips Hue",
    "nut": "UPS (NUT)",
    "awair": "Awair",
    "dyson_local": "Dyson", "dyson_cloud": "Dyson", "dyson": "Dyson",   # custom libdyson-wg/shenxn; "dyson" = old core
    "vesync": "Levoit (VeSync)",
    "tplink": "TP-Link Tapo", "tplink_tapo": "TP-Link Tapo", "tapo": "TP-Link Tapo",   # core, core alias, petretiandrea custom
    "flo": "Flo by Moen",
    "rachio": "Rachio",
    "waterguru": "WaterGuru",                          # custom: dwradcliffe/home-assistant-waterguru
    "chargepoint": "ChargePoint",                      # custom: mbillow/ha-chargepoint
    "roborock": "Roborock",
    "airnow": "Outdoor air quality",
    "open_meteo": "Weather forecast",
    "matter": "Matter",
    "mqtt": "MQTT",                                    # Zigbee2MQTT, ring-mqtt, ... read from the same broker
}
ALARM_STATES = {"disarmed", "armed_home", "armed_away", "armed_night", "armed_vacation", "arming", "pending", "triggered"}
WEATHER_ICON = {"sunny": "clear", "clear-night": "clear", "partlycloudy": "partly", "cloudy": "cloudy", "fog": "fog",
                "rainy": "rain", "pouring": "rain", "lightning": "storm", "lightning-rainy": "storm", "snowy": "snow",
                "snowy-rainy": "sleet", "hail": "sleet", "windy": "cloudy", "windy-variant": "cloudy", "exceptional": "cloudy"}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def to_celsius(v: float | None, unit: str | None) -> float | None:
    if v is None:
        return None
    return round((v - 32) * 5 / 9, 2) if (unit or "").upper().endswith("F") else v


def to_watts(v: float | None, unit: str | None) -> float | None:
    if v is None:
        return None
    return v * 1000 if (unit or "").lower() == "kw" else v


def color_hex(attrs: dict) -> str | None:
    rgb = attrs.get("rgb_color")
    if isinstance(rgb, (list, tuple)) and len(rgb) == 3 and all(isinstance(x, (int, float)) for x in rgb):
        return "#" + "".join(f"{max(0, min(255, int(x))):02x}" for x in rgb)
    return None


def map_entity(entity_id: str, state: str, attrs: dict) -> dict[str, tuple[Any, dict]] | None:
    """Map one HA entity to {capability: (value, cap kwargs)}; None = not imported."""
    domain = entity_id.split(".", 1)[0]
    unavailable = state in ("unavailable", "unknown", None)
    dc = attrs.get("device_class")
    unit = attrs.get("unit_of_measurement")
    out: dict[str, tuple[Any, dict]] = {}
    if domain == "binary_sensor":
        name, on, off = BINARY.get(dc, (None, True, False))
        if name is None:
            name = "state"
        out[name] = (None if unavailable else (on if state == "on" else off), {})
    elif domain == "sensor":
        v = _num(state)
        name = SENSOR.get(dc)
        if name is None:
            if v is None:
                return None                                    # text sensors aren't imported
            name = "value"
        if name == "temperature":
            v = to_celsius(v, unit)
            unit = "°C"
        elif name == "power":
            v = to_watts(v, unit)
            unit = "W"
        kw = {} if name in ("temperature", "humidity", "battery", "power") else {"unit": unit if isinstance(unit, str) else None}
        out[name] = (v, kw)
    elif domain == "light":
        on = None if unavailable else state == "on"
        out["light"] = (on, {})
        modes = attrs.get("supported_color_modes") or []
        if any(m != "onoff" for m in modes) or attrs.get("brightness") is not None:
            b = _num(attrs.get("brightness"))
            out["brightness"] = (round(b / 255 * 100) if b is not None else (0 if on is False else None), {"min": 1, "max": 100})
        if "color_temp" in modes or attrs.get("color_temp_kelvin") is not None:
            out["color_temp"] = (_num(attrs.get("color_temp_kelvin")), {})
        if any(m in ("hs", "rgb", "rgbw", "rgbww", "xy") for m in modes):
            out["color"] = (color_hex(attrs), {})
    elif domain in ("switch", "input_boolean"):
        out["switch"] = (None if unavailable else state == "on", {})
    elif domain == "fan":
        out["switch"] = (None if unavailable else state == "on", {"label": "Power"})
        pct = _num(attrs.get("percentage"))
        if pct is not None:
            out["fan_speed"] = (pct, {"writable": True, "min": 0, "max": 100, "step": max(1, int(_num(attrs.get("percentage_step")) or 1)), "unit": "%"})
    elif domain == "lock":
        out["lock"] = (None if unavailable else {"locked": "locked", "unlocked": "unlocked", "jammed": "jammed",
                                                "open": "unlocked"}.get(state, state), {})
    elif domain == "valve":
        out["valve"] = (None if unavailable else ("open" if state in ("open", "opening") else "closed"), {})
    elif domain == "cover":
        out["contact"] = (None if unavailable else ("open" if state in ("open", "opening") else "closed"), {})
        out["action"] = (None, {"writable": True, "options": ["open", "close", "stop"]})
    elif domain == "alarm_control_panel":
        out["alarm_panel"] = (state if state in ALARM_STATES else None, {})
    elif domain == "climate":
        cur = to_celsius(_num(attrs.get("current_temperature")), attrs.get("temperature_unit") or unit)
        if cur is not None:
            out["temperature"] = (cur, {})
        h = _num(attrs.get("current_humidity"))
        if h is not None:
            out["humidity"] = (h, {})
        out["status_text"] = (None if unavailable else str(attrs.get("hvac_action") or state).replace("_", " ").capitalize(), {"label": "Mode"})
    elif domain == "weather":
        tu = attrs.get("temperature_unit")
        for k, name in (("temperature", "temperature"), ("apparent_temperature", "feels_like")):
            v = to_celsius(_num(attrs.get(k)), tu)
            if v is not None:
                out[name] = (v, {"unit": "°C"} if name == "feels_like" else {})
        if _num(attrs.get("humidity")) is not None:
            out["humidity"] = (_num(attrs.get("humidity")), {})
        if _num(attrs.get("wind_speed")) is not None:
            out["wind_speed"] = (_num(attrs.get("wind_speed")), {"unit": attrs.get("wind_speed_unit"), "label": "Wind"})
        if _num(attrs.get("uv_index")) is not None:
            out["uv"] = (_num(attrs.get("uv_index")), {"label": "UV"})
        out["status_text"] = (None if unavailable else str(state).replace("-", " ").replace("partlycloudy", "partly cloudy").capitalize(), {"label": "Conditions"})
    else:
        return None
    return out


SERVICE = {  # (domain, capability, value) -> (service domain, service, data)
    "lock": lambda v: ("lock", "lock" if v == "lock" else "unlock", {}),
    "valve": lambda v: ("valve", "open_valve" if v == "open" else "close_valve", {}),
    "alarm_panel": lambda v: ("alarm_control_panel", {"disarm": "alarm_disarm", "arm_home": "alarm_arm_home",
                                                       "arm_away": "alarm_arm_away", "arm_night": "alarm_arm_night"}[v], {}),
}


class HomeAssistantAdapter(Adapter):
    source = "homeassistant"

    def __init__(self, hub, cfg):
        super().__init__(hub, cfg)
        self.url = str(cfg.get("url") or "").strip().rstrip("/")
        self.token = str(cfg.get("access_token") or "").strip()
        self.verify_ssl = bool(cfg.get("verify_ssl", True))
        self.areas_filter = {a.strip().lower() for a in _as_list(cfg.get("areas")) if a.strip()}
        self.exclude = [p.strip() for p in _as_list(cfg.get("exclude")) if p.strip()]
        self.domains = set(_as_list(cfg.get("domains")) or DOMAINS) & set(DOMAINS)
        self.include_native = bool(cfg.get("include_native", False))
        self.entry_domains: dict[str, str] = {}       # config entry id -> integration domain
        self.skipped: dict[str, int] = {}             # Haven integration label -> devices skipped
        self.imported = 0
        self.ws = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.entity_dev: dict[str, str] = {}          # entity_id -> haven device id
        self.entity_caps: dict[str, list[str]] = {}   # entity_id -> haven capability names on its device
        self.cap_entity: dict[tuple[str, str], str] = {}   # (haven device id, capability) -> entity_id
        self.registry: dict[str, dict] = {}
        self.devices_reg: dict[str, dict] = {}
        self.areas: dict[str, str] = {}
        try:
            self.refresh_hours = max(1.0, float(cfg.get("refresh_hours") or 24))
        except (TypeError, ValueError):
            self.refresh_hours = 24.0
        self._refresh_now = asyncio.Event()
        self._refreshed: asyncio.Future | None = None
        self.last_import: float | None = None

    async def start(self):
        if not self.url or not self.token:
            self.status = "enter your Home Assistant address and a long-lived access token"
            return
        if not re.match(r"^https?://[^\s/]+(:\d+)?(/.*)?$", self.url):
            self.status = "error: the address should look like http://192.168.1.10:8123"
            return
        self.spawn("ws", self._run, max_delay=60)

    async def stop(self):
        await super().stop()
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass

    # ---------------- websocket ----------------
    async def _send(self, msg: dict, timeout: float = 30) -> Any:
        self._id += 1
        msg = {"id": self._id, **msg}
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        await self.ws.send_str(json.dumps(msg))
        try:
            res = await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg["id"], None)
        if not res.get("success", True):
            raise RuntimeError(f"Home Assistant: {(res.get('error') or {}).get('message', 'request failed')}")
        return res.get("result")

    async def _run(self):
        import aiohttp
        ssl = True if self.verify_ssl else False
        ws_url = re.sub(r"^http", "ws", self.url) + "/api/websocket"
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(ws_url, heartbeat=30, ssl=ssl, max_msg_size=64 * 1024 * 1024) as ws:
                self.ws = ws
                first = await ws.receive_json(timeout=20)
                if first.get("type") != "auth_required":
                    raise RuntimeError("that address isn't Home Assistant's WebSocket API")
                await ws.send_str(json.dumps({"type": "auth", "access_token": self.token}))
                res = await ws.receive_json(timeout=20)
                if res.get("type") != "auth_ok":
                    self.status = "error: Home Assistant rejected the access token"
                    raise RuntimeError("Home Assistant rejected the access token")
                reader = asyncio.create_task(self._reader(ws))
                refresher = None
                try:
                    await self._load()
                    await self._send({"type": "subscribe_events", "event_type": "state_changed"})
                    refresher = asyncio.create_task(self._refresher())
                    await reader
                finally:
                    reader.cancel()
                    if refresher:
                        refresher.cancel()
                    if self._refreshed is not None and not self._refreshed.done():
                        self._refreshed.set_exception(RuntimeError("connection to Home Assistant closed"))
                        self._refreshed.exception()        # retrieved: no "never retrieved" warning if nobody waits
                    for f in self._pending.values():
                        if not f.done():
                            f.cancel()
                    self._pending.clear()
        self.ws = None
        for did in set(self.entity_dev.values()):
            if did in self.hub.devices:
                self.hub.set_values(did, {}, online=False)
        raise RuntimeError("connection to Home Assistant closed")

    async def _reader(self, ws):
        import aiohttp
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                    break
                continue
            try:
                data = json.loads(msg.data)
            except ValueError:
                continue
            for m in data if isinstance(data, list) else [data]:
                if m.get("type") == "result" and m.get("id") in self._pending:
                    f = self._pending[m["id"]]
                    if not f.done():
                        f.set_result(m)
                elif m.get("type") == "event":
                    ev = (m.get("event") or {}).get("data") or {}
                    ns = ev.get("new_state")
                    if ns and ev.get("entity_id") in self.entity_dev:
                        self._apply(ev["entity_id"], ns)

    async def _refresher(self):
        """Re-read areas, devices and entities once a day (renames, new devices, moved areas), or on request."""
        while True:
            try:
                await asyncio.wait_for(self._refresh_now.wait(), self.refresh_hours * 3600)
            except asyncio.TimeoutError:
                pass
            self._refresh_now.clear()
            done, self._refreshed = self._refreshed, None
            try:
                await self._load()
                if done and not done.done():
                    done.set_result(self.summary())
            except Exception as e:  # noqa: BLE001
                self.log.warning("Home Assistant refresh failed: %s", e)
                if done and not done.done():
                    done.set_exception(e)
                    done.exception()                       # retrieved: no warning if action() already gave up

    async def action(self, name: str) -> str:
        """Settings page buttons."""
        if name != "refresh":
            raise ValueError(name)
        if self.ws is None:
            raise RuntimeError("not connected to Home Assistant yet")
        if self._refreshed is None or self._refreshed.done():
            self._refreshed = asyncio.get_running_loop().create_future()
        fut = self._refreshed
        self._refresh_now.set()
        try:
            return await asyncio.wait_for(asyncio.shield(fut), 60)
        except asyncio.TimeoutError:
            return "Reading devices and areas from Home Assistant again…"

    def summary(self) -> str:
        n = self.imported
        msg = f"Imported {n} device{'s' if n != 1 else ''} from Home Assistant"
        if self.skipped:
            total = sum(self.skipped.values())
            names = sorted(self.skipped, key=lambda k: (-self.skipped[k], k))
            msg += f" · skipped {total} from {', '.join(names)} (Haven connects to those directly)"
        return msg

    # ---------------- import ----------------
    async def _load(self):
        areas = await self._send({"type": "config/area_registry/list"})
        devs = await self._send({"type": "config/device_registry/list"})
        ents = await self._send({"type": "config/entity_registry/list"})
        states = await self._send({"type": "get_states"})
        try:
            entries = await self._send({"type": "config_entries/get"})
        except Exception as e:  # noqa: BLE001 - older Home Assistant: fall back to device identifiers
            self.log.debug("config_entries/get failed: %s", e)
            entries = []
        self.entry_domains = {e["entry_id"]: e.get("domain") or "" for e in entries or [] if e.get("entry_id")}
        self.areas = {a["area_id"]: a.get("name") or a["area_id"] for a in areas or []}
        self.devices_reg = {d["id"]: d for d in devs or []}
        self.registry = {e["entity_id"]: e for e in ents or []}
        grouped: dict[str, list[dict]] = {}
        skipped: dict[str, set[str]] = {}
        for st in states or []:
            eid = st.get("entity_id", "")
            if not self._wanted(eid):
                continue
            mapped = map_entity(eid, st.get("state"), st.get("attributes") or {})
            if not mapped:
                continue
            reg = self.registry.get(eid) or {}
            key = reg.get("device_id") or eid
            native = None if self.include_native else self._native(eid)
            if native:
                skipped.setdefault(native, set()).add(key)
                continue
            grouped.setdefault(key, []).append(st)
        self.entity_dev.clear(); self.entity_caps.clear(); self.cap_entity.clear()
        count = 0
        for key, sts in grouped.items():
            if self._register(key, sts):
                count += 1
        keep = set(self.entity_dev.values())
        for did in [d.id for d in list(self.hub.devices.values()) if d.source == self.source and d.id not in keep]:
            self.hub.remove_device(did)                    # removed, filtered out, or now covered by a Haven integration
        import time as _time
        self.last_import = _time.time()
        self.imported = count
        self.skipped = {k: len(v) for k, v in skipped.items()}
        if count:
            self.status = "ok · " + self.summary()[len("Imported "):]
        else:
            self.status = "connected, but no matching entities (check the area / type filters)" + (
                " · " + self.summary().split(" · ", 1)[1] if self.skipped else "")

    def _integrations(self, eid: str) -> set[str]:
        """Home Assistant integration domains behind an entity: its device's config entries and identifiers,
        or (for an entity without a device) its own platform and config entry."""
        reg = self.registry.get(eid) or {}
        dev = self.devices_reg.get(reg.get("device_id") or "")
        if dev:
            out = {self.entry_domains.get(c) for c in dev.get("config_entries") or []}
            out |= {i[0] for i in dev.get("identifiers") or [] if isinstance(i, (list, tuple)) and i}
        else:
            out = {reg.get("platform"), self.entry_domains.get(reg.get("config_entry_id") or "")}
        return {d for d in out if isinstance(d, str) and d}

    def _native(self, eid: str) -> str | None:
        """The Haven integration that already covers this entity's device, if any."""
        hits = sorted(NATIVE[d] for d in self._integrations(eid) if d in NATIVE)
        return hits[0] if hits else None

    def _wanted(self, eid: str) -> bool:
        domain = eid.split(".", 1)[0]
        if domain not in self.domains:
            return False
        reg = self.registry.get(eid) or {}
        if reg.get("disabled_by") or reg.get("hidden_by"):
            return False
        if reg.get("entity_category") in SKIP_CATEGORIES and "battery" not in eid:
            return False                                   # settings/diagnostics; battery level is kept
        if any(fnmatch.fnmatch(eid, p) for p in self.exclude):
            return False
        if self.areas_filter:
            area = (self._area_name(eid) or "").lower()
            if area not in self.areas_filter:
                return False
        return True

    def _area_name(self, eid: str) -> str | None:
        reg = self.registry.get(eid) or {}
        area_id = reg.get("area_id") or (self.devices_reg.get(reg.get("device_id")) or {}).get("area_id")
        return self.areas.get(area_id) if area_id else None

    def _register(self, key: str, sts: list[dict]) -> bool:
        did = self.dev_id(key.replace(".", "_"))
        devreg = self.devices_reg.get(key) or {}
        first = sts[0]
        name = devreg.get("name_by_user") or devreg.get("name") or (first.get("attributes") or {}).get("friendly_name") or first["entity_id"]
        model = " ".join(x for x in (devreg.get("manufacturer"), devreg.get("model")) if x) or "Home Assistant"
        caps: dict[str, Any] = {}
        values: dict[str, Any] = {}
        kind = None
        for st in sts:
            eid = st["entity_id"]
            mapped = map_entity(eid, st.get("state"), st.get("attributes") or {}) or {}
            names = []
            for cname, (v, kw) in mapped.items():
                final = cname
                if final in caps:                          # two entities give the same reading: keep both
                    final = f"{cname}_{re.sub(r'[^A-Za-z0-9_]', '_', eid.split('.', 1)[1])[-20:]}"
                kw = dict(kw)
                if eid.split(".")[0] in ("light", "switch", "input_boolean", "lock", "valve", "alarm_control_panel", "fan", "cover") \
                        and cname in ("light", "switch", "lock", "valve", "alarm_panel", "brightness", "color_temp", "color", "fan_speed", "action"):
                    kw["writable"] = True
                label = (st.get("attributes") or {}).get("friendly_name")
                if cname in ("value", "state") and label:
                    kw.setdefault("label", str(label)[:40])
                caps[final] = cap(final, **kw)
                values[final] = v
                names.append(final)
                self.cap_entity[(did, final)] = eid
            self.entity_dev[eid] = did
            self.entity_caps[eid] = names
            domain = eid.split(".")[0]
            if domain == "weather":
                kind = "weather"
            elif domain == "light" and kind is None:
                kind = "light"
        if not caps:
            return False
        room = self._area_name(first["entity_id"]) or ((self.areas.get(devreg.get("area_id"))) if devreg else None)
        self.hub.upsert_device(Device(id=did, name=str(name)[:80], source=self.source, model=model[:80], room=room, capabilities=caps))
        attrs = {"ha_entities": [s["entity_id"] for s in sts][:40]}
        if kind:
            attrs["kind"] = kind
        if kind == "weather":
            wa = next((s.get("attributes") or {} for s in sts if s["entity_id"].startswith("weather.")), {})
            wst = next((s.get("state") for s in sts if s["entity_id"].startswith("weather.")), "")
            attrs.update(icon=WEATHER_ICON.get(wst, "cloudy"), is_day=wst != "clear-night", place=wa.get("friendly_name"))
        self.hub.set_attributes(did, attrs)
        online = any(s.get("state") not in ("unavailable",) for s in sts)
        self.hub.set_values(did, {k: v for k, v in values.items() if v is not None}, online=online)
        return True

    def _apply(self, eid: str, ns: dict):
        did = self.entity_dev[eid]
        mapped = map_entity(eid, ns.get("state"), ns.get("attributes") or {}) or {}
        names = self.entity_caps.get(eid, [])
        vals = {}
        for (cname, (v, _kw)), final in zip(mapped.items(), names):
            if v is not None:
                vals[final] = v
        if eid.startswith("weather."):
            self.hub.set_attributes(did, {"icon": WEATHER_ICON.get(ns.get("state"), "cloudy"), "is_day": ns.get("state") != "clear-night"})
        self.hub.set_values(did, vals, online=ns.get("state") != "unavailable")

    # ---------------- control ----------------
    async def command(self, device: Device, capability: str, value: Any):
        eid = self.cap_entity.get((device.id, capability))
        if not eid or self.ws is None:
            raise RuntimeError("not connected to Home Assistant")
        domain = eid.split(".")[0]
        base = capability.split("_")[0] if capability not in ("alarm_panel", "fan_speed", "color_temp") else capability
        data: dict[str, Any] = {}
        if base in SERVICE:
            sdomain, service, data = SERVICE[base](value)
        elif capability in ("light", "switch") or base in ("light", "switch"):
            sdomain, service = domain, "turn_on" if value else "turn_off"
        elif capability == "brightness":
            sdomain, service, data = "light", "turn_on", {"brightness_pct": max(1, min(100, int(value)))}
        elif capability == "color_temp":
            sdomain, service, data = "light", "turn_on", {"color_temp_kelvin": int(value)}
        elif capability == "color":
            h = str(value).lstrip("#")
            if not re.fullmatch(r"[0-9a-fA-F]{6}", h):
                raise ValueError("color must be #rrggbb")
            sdomain, service, data = "light", "turn_on", {"rgb_color": [int(h[i:i + 2], 16) for i in (0, 2, 4)]}
        elif capability == "fan_speed":
            sdomain, service, data = "fan", "set_percentage", {"percentage": max(0, min(100, int(value)))}
        elif capability == "action" and domain == "cover":
            sdomain, service = "cover", {"open": "open_cover", "close": "close_cover", "stop": "stop_cover"}[value]
        else:
            raise ValueError(f"{capability} can't be controlled")
        await self._send({"type": "call_service", "domain": sdomain, "service": service,
                          "target": {"entity_id": eid}, "service_data": data}, timeout=20)


def _as_list(v: Any) -> list[str]:
    items = v if isinstance(v, list) else str(v or "").replace("\n", ",").split(",")
    return [str(x).strip() for x in items if str(x).strip()]


ADAPTER = HomeAssistantAdapter
SETTINGS = {
    "id": "homeassistant", "label": "Home Assistant", "icon": "home",
    "help": "Shows the devices you already have in Home Assistant and controls them through it, so you don't need to "
            "connect each brand to Haven separately. In Home Assistant open your profile → Security → Long-lived access "
            "tokens → Create token, and paste it here with Home Assistant's address (e.g. http://192.168.1.10:8123). "
            "Cards follow Home Assistant's devices and areas. Devices that Home Assistant gets from a brand Haven "
            "connects to directly (YoLink, Aqara, Ecowitt, X-Sense, Ring, Philips Hue, NUT, Awair, Dyson, VeSync, "
            "TP-Link/Tapo, Flo, Rachio, WaterGuru, ChargePoint, Roborock, AirNow, Open-Meteo, Matter and MQTT) are "
            "not imported, even if that Haven integration is off, so nothing shows up twice: connect those brands "
            "in Haven instead. Refresh now shows how many were skipped.",
    "fields": [
        {"key": "url", "label": "Home Assistant address", "type": "text", "default": "http://homeassistant.local:8123"},
        {"key": "access_token", "label": "Long-lived access token", "type": "password"},
        {"key": "areas", "label": "Only these areas (optional, comma-separated)", "type": "list"},
        {"key": "exclude", "label": "Skip entities (optional, e.g. sensor.*_rssi, light.hallway)", "type": "list"},
        {"key": "domains", "label": "Entity types to import", "type": "list",
         "default": ["sensor", "binary_sensor", "light", "switch", "lock", "valve", "cover", "alarm_control_panel", "fan", "climate", "weather"]},
        {"key": "refresh_hours", "label": "Re-read devices and areas every (hours)", "type": "number", "default": 24},
        {"key": "verify_ssl", "label": "Check the HTTPS certificate", "type": "bool", "default": True},
        {"key": "include_native", "label": "Also import devices from integrations Haven connects to directly",
         "type": "bool", "default": False, "advanced": True,
         "help": "Off: YoLink, Hue, Tapo, MQTT, Matter and the other brands Haven supports come only from Haven's own "
                 "integrations. On: they come from Home Assistant too, which can show the same device twice."},
    ],
    # buttons on the Settings page (POST /api/settings/homeassistant/action/<id>)
    "actions": [{"id": "refresh", "label": "Refresh now", "icon": "sync"}],
}
