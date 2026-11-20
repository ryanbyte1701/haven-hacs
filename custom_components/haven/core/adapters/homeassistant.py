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

A few Home Assistant integrations get Haven's own presentation, so they look like Haven's integrations:
- NUT (UPS) devices: their sensors (ups.status, battery.charge, battery.runtime, ups.load, voltages, real power)
  become the same UPS capabilities app/adapters/nut.py produces (parse_status), so the Power page shows them;
- weather.* entities: the daily forecast (weather.get_forecasts, every 30 minutes and when the condition
  changes) goes into the device's attributes like app/adapters/weather.py's, for the Home page weather card;
- outdoor air quality services (AirNow, WAQI, IQAir, ...): kind "aqi_station", like app/adapters/airquality.py,
  for the Home page "Outdoor air" tile and the Air quality page.

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
import time
from datetime import datetime
from typing import Any

from ..models import Device, cap
from .base import Adapter
from .ha_rules import (APPLIANCE_DOMAINS, NETWORK_DOMAINS, OUTDOOR_AQI, OWN_OPENINGS, SHADE_CLASSES, SHADE_HINT,  # noqa: F401 - re-exported
                       SMOKE_DOMAINS, SMOKE_HINT, SMOKE_TEXT, VEHICLE_DOMAINS, DeviceFacts, classify)
from .nut import UPS_CAPS, parse_status

DOMAINS = ["sensor", "binary_sensor", "light", "switch", "input_boolean", "siren", "lock", "valve", "cover",
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
DOMAIN_LABELS = {   # entity types, as Settings shows them
    "sensor": "Readings (temperature, power, battery…)", "binary_sensor": "On/off sensors (doors, motion, leaks, smoke)",
    "light": "Lights", "switch": "Switches & plugs", "input_boolean": "Helper toggles", "siren": "Sirens", "lock": "Locks",
    "valve": "Valves", "cover": "Blinds, shades & garage doors", "alarm_control_panel": "Alarm panels", "fan": "Fans",
    "climate": "Thermostats", "weather": "Weather & forecast"}
_INTEGRATION_NAMES = {
    "tplink": "TP-Link", "tplink_omada": "TP-Link Omada", "tplink_deco": "TP-Link Deco", "ecobee": "ecobee", "mqtt": "MQTT",
    "zha": "Zigbee (ZHA)", "zwave_js": "Z-Wave", "esphome": "ESPHome", "hue": "Philips Hue", "unifi": "UniFi Network",
    "unifiprotect": "UniFi Protect", "hassio": "Home Assistant add-ons", "hacs": "HACS", "mobile_app": "Phones (Companion app)",
    "met": "Met.no weather", "sun": "Sun", "nut": "NUT (UPS)", "kia_uvo": "Kia / Hyundai", "hyundai_kia_connect": "Hyundai / Kia",
    "google_nest": "Google Nest", "nest": "Google Nest", "smartthings": "SmartThings", "homekit_controller": "HomeKit devices",
    "upnp": "UPnP", "dlna_dmr": "DLNA", "cast": "Google Cast", "sonos": "Sonos", "xsense": "X-Sense", "yolink": "YoLink",
    "ring": "Ring", "opower": "Utility (Opower)", "shelly": "Shelly", "template": "Templates", "group": "Groups",
    "input_boolean": "Helpers", "wled": "WLED", "lifx": "LIFX", "wiz": "WiZ", "govee_light_local": "Govee", "lutron_caseta": "Lutron Caséta",
    "waterguru": "WaterGuru", "roborock": "Roborock", "ecowitt": "Ecowitt", "matter": "Matter",
}


def integration_label(domain: str) -> str:
    return _INTEGRATION_NAMES.get(domain) or domain.replace("_", " ").title()


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
# Home Assistant weather condition -> the words app/adapters/weather.py uses for the same weather
WEATHER_TEXT = {"sunny": "Sunny", "clear-night": "Clear", "partlycloudy": "Partly cloudy", "cloudy": "Cloudy", "fog": "Fog",
                "rainy": "Rain", "pouring": "Heavy rain", "lightning": "Thunderstorm", "lightning-rainy": "Thunderstorm",
                "snowy": "Snow", "snowy-rainy": "Sleet", "hail": "Hail", "windy": "Windy", "windy-variant": "Windy, cloudy",
                "exceptional": "Exceptional"}
FORECAST_SECONDS = 30 * 60      # weather.get_forecasts for each weather entity this often (and when its condition changes)

# Home Assistant's NUT integration (homeassistant/components/nut/sensor.py): sensor translation key -> NUT variable.
NUT_KEYS = {"ups_status": "ups.status", "ups_status_display": "ups.status.display", "battery_charge": "battery.charge",
            "battery_runtime": "battery.runtime", "ups_load": "ups.load", "input_voltage": "input.voltage",
            "output_voltage": "output.voltage", "ups_realpower": "ups.realpower",
            "ups_realpower_nominal": "ups.realpower.nominal"}
# ... and by entity id, from the English entity names ("Status data", "Battery charge", ...), most specific first
NUT_SUFFIXES = (("_status_data", "ups.status"), ("_battery_charge", "battery.charge"), ("_battery_runtime", "battery.runtime"),
                ("_input_voltage", "input.voltage"), ("_output_voltage", "output.voltage"),
                ("_nominal_real_power", "ups.realpower.nominal"), ("_real_power", "ups.realpower"), ("_load", "ups.load"),
                ("_status", "ups.status.display"))
# the "Status" sensor's words (nut/const.py STATE_TYPES) -> NUT status flags, for when "Status data" is disabled
STANDBY_WHEN_UNAVAILABLE = {"sense"}     # integrations whose entities are "unavailable" simply while the appliance is off
NUT_STATUS_WORDS = {"online": "OL", "on battery": "OB", "low battery": "LB", "high battery": "HB",
                    "battery needs replacement": "RB", "battery charging": "CHRG", "battery discharging": "DISCHRG",
                    "bypass active": "BYPASS", "runtime calibration": "CAL", "offline": "OFF", "overloaded": "OVER",
                    "trimming voltage": "TRIM", "boosting voltage": "BOOST", "forced shutdown": "FSD", "alarm": "ALARM"}
SECONDS = {"ms": 0.001, "s": 1, "min": 60, "h": 3600, "d": 86400}
# Outdoor air quality services in Home Assistant: their devices become Haven's "aqi_station" (Home page "Outdoor air")

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
        low = entity_id.lower()
        if dc == "distance" or (unit in ("km", "mi") and v is not None):    # cars: odometer and driving range
            name = "odometer" if ("odometer" in low or "mileage" in low) else "range" if "range" in low else "distance"
        elif "fuel_level" in low and unit == "%":
            name = "fuel_level"
        if name is None and v is None and str(state).lower() in SMOKE_TEXT \
                and re.search(r"smoke|carbon_monoxide|\bco_|fire", f"{low} {str(attrs.get('friendly_name') or '').lower()}"):
            # a smoke/CO alarm reporting its state as text ("normal" / "alarm"), e.g. some X-Sense and Kidde setups
            name = "co" if re.search(r"carbon_monoxide|\bco_|carbon monoxide", f"{low} {str(attrs.get('friendly_name') or '').lower()}") else "smoke"
            out[name] = (None if unavailable else SMOKE_TEXT[str(state).lower()], {})
            return out
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
    elif domain == "siren":                             # e.g. a Ring camera's siren: its own control, never "Power"
        out["switch"] = (None if unavailable else state == "on", {"label": "Siren"})
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
        is_open = None if unavailable else state in ("open", "opening")
        if dc in SHADE_CLASSES or (dc in (None, "") and SHADE_HINT.search(f"{entity_id} {attrs.get('friendly_name') or ''}")):
            # blinds, shades, curtains, awnings, shutters: window coverings, not doors (and never "not secure")
            out["shade"] = (None if is_open is None else ("open" if is_open else "closed"), {"label": "Shade"})
            if "current_position" in attrs:
                out["position"] = (_num(attrs.get("current_position")), {"writable": True, "min": 0, "max": 100, "step": 1, "unit": "%", "label": "Open"})
        else:
            out["contact"] = (None if is_open is None else ("open" if is_open else "closed"), {})
        out["action"] = (None, {"writable": True, "options": ["open", "close", "stop"]})
    elif domain == "alarm_control_panel":
        out["alarm_panel"] = (state if state in ALARM_STATES else None, {})
    elif domain == "climate":
        # Climate attributes are in Home Assistant's own unit system (the adapter adds it as temperature_unit).
        # The same capabilities in the same order on every update (_apply pairs them by position), so the
        # setpoints are decided by what the thermostat supports, not by its current mode.
        tu = attrs.get("temperature_unit") or unit
        c = lambda k: to_celsius(_num(attrs.get(k)), tu)  # noqa: E731
        out["temperature"] = (c("current_temperature"), {})
        if "current_humidity" in attrs:
            out["humidity"] = (_num(attrs.get("current_humidity")), {})
        out["status_text"] = (None if unavailable else str(attrs.get("hvac_action") or state).replace("_", " ").capitalize(), {"label": "Mode"})
        modes = [str(m) for m in attrs.get("hvac_modes") or [] if m]
        if modes:
            out["hvac_mode"] = (None if unavailable else state, {"writable": True, "options": modes, "label": "Mode"})
        out["hvac_action"] = (None if unavailable else attrs.get("hvac_action"), {"label": "Running"})
        feats = int(_num(attrs.get("supported_features")) or 0)
        lo, hi = c("min_temp"), c("max_temp")
        rng = {"writable": True, "unit": "°C", "min": lo if lo is not None else 7, "max": hi if hi is not None else 35, "step": 0.5}
        if feats & 1 or "temperature" in attrs:                 # TARGET_TEMPERATURE: one setpoint (heat or cool)
            out["target_temperature"] = (c("temperature"), {**rng, "label": "Set to"})
        if feats & 2 or "target_temp_low" in attrs:             # TARGET_TEMPERATURE_RANGE: heat_cool / auto
            out["heat_setpoint"] = (c("target_temp_low"), {**rng, "label": "Heat to"})
            out["cool_setpoint"] = (c("target_temp_high"), {**rng, "label": "Cool to"})
        if attrs.get("fan_modes"):
            out["fan_mode"] = (attrs.get("fan_mode"), {"writable": True, "options": [str(m) for m in attrs["fan_modes"]], "label": "Fan"})
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
        if _num(attrs.get("wind_gust_speed")) is not None:
            out["wind_gust"] = (_num(attrs.get("wind_gust_speed")), {"unit": attrs.get("wind_speed_unit"), "label": "Gust"})
        if _num(attrs.get("pressure")) is not None:
            out["pressure"] = (_num(attrs.get("pressure")), {"unit": attrs.get("pressure_unit")})
        out["status_text"] = (None if unavailable else weather_text(state), {"label": "Conditions"})
    else:
        return None
    return out


def weather_text(condition: Any) -> str:
    c = str(condition or "")
    return WEATHER_TEXT.get(c) or c.replace("-", " ").capitalize()


def _timestamp(v: Any) -> int | None:
    try:
        return int(datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return None


def parse_forecast(items: Any, attrs: dict) -> dict:
    """weather.get_forecasts (type daily) -> the attributes app/adapters/weather.py gives its device:
    {"daily": [{t, text, icon, hi, lo, pop, rain, uv, sunrise, sunset}], "units": {"wind", "rain"}}.
    Temperatures in °C like Open-Meteo's (the UI converts); rain in the weather entity's precipitation unit."""
    tu = attrs.get("temperature_unit")
    days = []
    for f in items if isinstance(items, list) else []:
        if not isinstance(f, dict) or f.get("is_daytime") is False:      # twice_daily: keep the day halves
            continue
        t = _timestamp(f.get("datetime"))
        if t is None:
            continue
        c = f.get("condition")
        days.append({"t": t, "text": weather_text(c), "icon": WEATHER_ICON.get(c, "cloudy"),
                     "hi": to_celsius(_num(f.get("temperature")), tu), "lo": to_celsius(_num(f.get("templow")), tu),
                     "pop": _num(f.get("precipitation_probability")), "rain": _num(f.get("precipitation")),
                     "uv": _num(f.get("uv_index")), "sunrise": None, "sunset": None})
    return {"daily": days[:7], "units": {"wind": attrs.get("wind_speed_unit") or "", "rain": attrs.get("precipitation_unit") or ""}}


def nut_vars(states: dict[str, tuple[Any, dict]]) -> dict[str, str]:
    """{NUT variable: (HA state, HA attributes)} of one UPS -> NUT variables as upsd sends them (runtime in seconds,
    power in W, the status as flags), for nut.parse_status."""
    out: dict[str, str] = {}
    for var, (st, attrs) in states.items():
        if st in (None, "unknown", "unavailable", "") or var == "ups.status.display":
            continue
        unit = (attrs or {}).get("unit_of_measurement")
        if var == "battery.runtime":
            v = _num(st)
            if v is None:
                continue
            st = f"{v * SECONDS.get(str(unit or 's'), 1):g}"
        elif var.startswith("ups.realpower"):
            v = to_watts(_num(st), unit)
            if v is None:
                continue
            st = f"{v:g}"
        out[var] = str(st)
    disp = states.get("ups.status.display")
    if "ups.status" not in out and disp and disp[0] not in (None, "unknown", "unavailable"):
        flags = [NUT_STATUS_WORDS.get(w.strip().lower()) for w in str(disp[0]).split(",")]
        if any(flags):
            out["ups.status"] = " ".join(f for f in flags if f)
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
        self.skip_integrations = {x.strip().lower() for x in _as_list(cfg.get("skip_integrations")) if x.strip()}
        self.found: dict[str, set[str]] = {}          # HA integration domain -> device keys it brings (Settings list)
        self.found_native: dict[str, str] = {}        # HA integration domain -> the Haven integration covering it
        self.user_skipped = 0
        self.entry_domains: dict[str, str] = {}       # config entry id -> integration domain
        self.skipped: dict[str, int] = {}             # Haven integration label -> devices skipped
        self.imported = 0
        self.ws = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.entity_dev: dict[str, str] = {}          # entity_id -> haven device id
        # entity_id -> {capability map_entity gives it: the name it has on its Haven device} (renamed when two
        # entities give the same reading, for extra switches, appliance openings…). Live updates use it by name.
        self.entity_caps: dict[str, dict[str, str]] = {}
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
        self._load_lock: asyncio.Lock | None = None
        self.avail: dict[str, bool] = {}          # entity id -> is it available
        self.dev_ents: dict[str, list[str]] = {}  # device id -> its entities
        self._held: list | None = None          # state changes that arrived during a load
        self.last_import: float | None = None
        # NUT (UPS) devices: entity_id -> NUT variable, and per Haven device {NUT variable: (state, attributes)}
        self.entity_nut: dict[str, str] = {}
        self.nut_states: dict[str, dict[str, tuple[Any, dict]]] = {}
        # weather entities: the latest attributes and condition, the forecast, when it was fetched
        self.weather_attrs: dict[str, dict] = {}
        self.weather_state: dict[str, Any] = {}
        self.forecasts: dict[str, dict] = {}
        self._forecast_at: dict[str, float] = {}
        self._forecast_due: set[str] = set()
        self._forecast_now = asyncio.Event()

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
                refresher = forecaster = None
                try:
                    self._held = []                     # changes that arrive from now until the first read finishes
                    await self._send({"type": "subscribe_events", "event_type": "state_changed"})   # before the load: no gap
                    await self._load()
                    refresher = asyncio.create_task(self._refresher())
                    forecaster = asyncio.create_task(self._forecaster())
                    await reader
                finally:
                    reader.cancel()
                    for t in (refresher, forecaster):
                        if t:
                            t.cancel()
                    if self._refreshed is not None and not self._refreshed.done():
                        self._refreshed.set_exception(RuntimeError("connection to Home Assistant closed"))
                        self._refreshed.exception()        # retrieved: no "never retrieved" warning if nobody waits
                    for f in self._pending.values():
                        if not f.done():
                            f.set_exception(ConnectionError("connection to Home Assistant closed"))
                            f.exception()                  # retrieved: no warning if nobody is waiting
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
                    if ns and ev.get("entity_id") and self._held is not None:
                        self._held.append((ev["entity_id"], ns))
                    elif ns and ev.get("entity_id") in self.entity_dev:
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
        if self.user_skipped:
            msg += f" · {self.user_skipped} from integrations you turned off"
        return msg

    # ---------------- import ----------------
    temp_unit = "°C"           # Home Assistant's unit system (get_config): climate attributes use it

    def _attrs(self, eid: str, attrs: dict | None) -> dict:
        attrs = attrs or {}
        if eid.startswith(("climate.", "water_heater.")) and not attrs.get("temperature_unit"):
            return {**attrs, "temperature_unit": self.temp_unit}
        return attrs

    async def _load(self):
        """Read Home Assistant's registries and states. One read at a time; state changes that arrive while one
        is running are held and applied after it, so an older snapshot never overwrites a newer change."""
        if self._load_lock is None:
            self._load_lock = asyncio.Lock()
        async with self._load_lock:
            if self._held is None:
                self._held = []
            try:
                await self._load_now()
            finally:
                held, self._held = self._held, None
            for eid, ns in held:
                if eid in self.entity_dev:
                    self._apply(eid, ns)

    async def _load_now(self):
        try:
            conf = await self._send({"type": "get_config"})
            self.temp_unit = str(((conf or {}).get("unit_system") or {}).get("temperature") or "°C")
        except Exception as e:  # noqa: BLE001
            self.log.debug("get_config failed: %s", e)
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
        found: dict[str, set[str]] = {}
        found_native: dict[str, str] = {}
        user_skipped: set[str] = set()
        for st in states or []:
            eid = st.get("entity_id", "")
            if not self._wanted(eid):
                continue
            mapped = map_entity(eid, st.get("state"), self._attrs(eid, st.get("attributes")))
            if not mapped and not self._nut_var(eid):          # NUT's "Status data" is text
                continue
            reg = self.registry.get(eid) or {}
            key = reg.get("device_id") or eid
            integ = self._main_integrations(eid)
            for d in integ:
                found.setdefault(d, set()).add(key)
            if integ & self.skip_integrations:                 # turned off under Settings → Home Assistant
                user_skipped.add(key)
                continue
            native = None if self.include_native else self._native(eid)
            if native:
                for d in integ:
                    found_native[d] = native
            if native:
                skipped.setdefault(native, set()).add(key)
                continue
            grouped.setdefault(key, []).append(st)
        self.entity_dev.clear(); self.entity_caps.clear(); self.cap_entity.clear()
        self.entity_nut.clear(); self.nut_states.clear()
        count = 0
        for key, sts in grouped.items():
            if self._register(key, sts):
                count += 1
        keep = set(self.entity_dev.values())
        for did in [d.id for d in list(self.hub.devices.values()) if d.source == self.source and d.id not in keep]:
            self.hub.remove_device(did)                    # removed, filtered out, or now covered by a Haven integration
        self.last_import = time.time()
        self._forecast_now.set()                           # forecasts for weather entities that are new
        self.imported = count
        self.skipped = {k: len(v) for k, v in skipped.items()}
        self.found, self.found_native, self.user_skipped = found, found_native, len(user_skipped - set(grouped))
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

    def _eff(self, eid: str, state):
        """The state to use for an entity. Sense lists every appliance it has detected and marks it "unavailable"
        whenever it isn't drawing power: that means off, not broken, so such an entity reads as off."""
        if state == "unavailable" and STANDBY_WHEN_UNAVAILABLE & self._integrations(eid):
            return "off"
        return state

    @staticmethod
    def _standby_zero(standby: bool, mapped: dict) -> dict:
        """An appliance that is off draws nothing: a Sense power or current sensor that went "unavailable" reads 0."""
        if not standby:
            return mapped
        return {k: ((0.0, kw) if k in ("power", "current") and v is None else (v, kw)) for k, (v, kw) in mapped.items()}

    def _device_online(self, did: str, eid: str) -> bool:
        """A device is online while any of its entities is available (one unavailable sensor doesn't take it down)."""
        return any(self.avail.get(e, True) for e in self.dev_ents.get(did) or [eid])

    def _main_integrations(self, eid: str) -> set[str]:
        """The integration(s) a device comes from, as Settings lists them: its config entries' domains (an ecobee
        thermostat is "ecobee", not every identifier namespace it carries); otherwise _integrations()."""
        reg = self.registry.get(eid) or {}
        dev = self.devices_reg.get(reg.get("device_id") or "")
        out = {self.entry_domains.get(c) for c in (dev or {}).get("config_entries") or []}
        if not dev:
            out.add(self.entry_domains.get(reg.get("config_entry_id") or ""))
        out = {d for d in out if isinstance(d, str) and d}
        # add-ons that attach to other integrations' devices (Battery Notes, …) aren't where the device comes from:
        # prefer the entries that also named the device (its identifiers)
        idents = {i[0] for i in (dev or {}).get("identifiers") or [] if isinstance(i, (list, tuple)) and i}
        return (out & idents) or out or self._integrations(eid)

    def choices(self) -> dict:
        """Settings → Home Assistant: the integrations found in Home Assistant (with how many devices each brings)
        and the entity types, as switches. Integrations a Haven integration covers are listed but can't be switched."""
        names = set(self.found) | self.skip_integrations
        integ = [{"id": d, "label": integration_label(d), "count": len(self.found.get(d, ())),
                  **({"locked": f"comes from Haven's {self.found_native[d]} integration"} if d in self.found_native else {})}
                 for d in names]
        integ.sort(key=lambda x: ("locked" in x, x["label"].lower()))
        return {"skip_integrations": integ,
                "domains": [{"id": d, "label": DOMAIN_LABELS.get(d, d)} for d in DOMAINS]}

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
        if reg.get("entity_category") in SKIP_CATEGORIES and "battery" not in eid and not self._nut_var(eid):
            return False                                   # settings/diagnostics; battery level and UPS readings are kept
        if any(fnmatch.fnmatch(eid, p) for p in self.exclude):
            return False
        if self.areas_filter:
            area = (self._area_name(eid) or "").lower()
            if area not in self.areas_filter:
                return False
        return True

    def _nut_var(self, eid: str) -> str | None:
        """The NUT variable a sensor of Home Assistant's NUT integration shows (ups.status, battery.charge, ...)."""
        if not eid.startswith("sensor.") or "nut" not in self._integrations(eid):
            return None
        reg = self.registry.get(eid) or {}
        if reg.get("translation_key") in NUT_KEYS:
            return NUT_KEYS[reg["translation_key"]]
        uid = str(reg.get("unique_id") or "")                # "<UPS unique id>_<NUT variable>"
        for var in NUT_KEYS.values():
            if uid.endswith("_" + var):
                return var
        obj = re.sub(r"_\d+$", "", eid.split(".", 1)[1])     # sensor.ups_load_2
        for suffix, var in NUT_SUFFIXES:
            if obj.endswith(suffix):
                return var
        return None

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
        mapped_domains: set[str] = set()
        has_switch = outlet = has_light = False
        nut: dict[str, tuple[Any, dict]] = {}
        for st in sts:
            eid = st["entity_id"]
            dom = eid.split(".")[0]
            var = self._nut_var(eid)
            if var:                                    # a UPS reading: combined below, like app/adapters/nut.py
                nut[var] = (st.get("state"), st.get("attributes") or {})
                self.entity_nut[eid] = var
                self.entity_dev[eid] = did
                self.entity_caps[eid] = {}
                continue
            if dom == "switch" and not self._switch_suffix(eid, st, str(name)):
                has_switch = True
                outlet = outlet or (st.get("attributes") or {}).get("device_class") == "outlet"
            elif dom == "light":
                has_light = True
            eff = self._eff(eid, st.get("state"))
            mapped = self._standby_zero(eff != st.get("state"), map_entity(eid, eff, self._attrs(eid, st.get("attributes"))) or {})
            # A device's extra switches (a Ring camera's Siren, Motion detection, Privacy mode…) are their own
            # controls named after the entity, not the device's "Power" switch.
            extra = self._switch_suffix(eid, st, str(name)) if dom in ("switch", "input_boolean", "siren") else None
            names: dict[str, str] = {}
            for cname, (v, kw) in mapped.items():
                orig = cname
                if extra and cname == "switch":
                    cname = "switch_" + re.sub(r"[^a-z0-9]+", "_", extra.lower()).strip("_")[:24]
                    kw = {**kw, "label": extra[:40]}
                if cname == "energy_total":            # TP-Link/Tapo & co: "Today's" / "This month's consumption"
                    hint = f"{eid} {(st.get('attributes') or {}).get('friendly_name') or ''}".lower()
                    if "today" in hint or "daily" in hint:
                        cname = "energy_today"
                    elif "month" in hint:
                        cname = "energy_month"
                final = cname
                if final in caps:                          # two entities give the same reading: keep both
                    final = f"{cname}_{re.sub(r'[^A-Za-z0-9_]', '_', eid.split('.', 1)[1])[-20:]}"
                kw = dict(kw)
                if dom in ("binary_sensor", "sensor"):
                    kw["writable"] = False             # a plug-type binary sensor reports; it can't be switched
                if eid.split(".")[0] in ("light", "switch", "input_boolean", "siren", "lock", "valve", "alarm_control_panel", "fan", "cover") \
                        and (cname in ("light", "switch", "lock", "valve", "alarm_panel", "brightness", "color_temp", "color", "fan_speed", "action", "position")
                             or cname.startswith("switch_")):
                    kw["writable"] = True
                label = (st.get("attributes") or {}).get("friendly_name")
                if cname in ("value", "state") and label:
                    kw.setdefault("label", str(label)[:40])
                caps[final] = cap(final, **kw)
                values[final] = v
                names[orig] = final
                self.cap_entity[(did, final)] = eid
            self.entity_dev[eid] = did
            self.entity_caps[eid] = names
            mapped_domains.add(eid.split(".")[0])
        nv: dict[str, str] = {}
        if nut:
            self.nut_states[did] = nut
            nv = nut_vars(nut)
            for c in UPS_CAPS:
                caps.setdefault(c, cap(c))
            values.update(parse_status(nv))
        if not caps:
            return False
        # what kind of device this is: one ordered table of rules (app/adapters/ha_rules.py)
        kind = classify(DeviceFacts(
            name=str(name), model=str(devreg.get("model") or ""), caps=set(caps), values=values, domains=mapped_domains,
            integrations=set().union(*(self._integrations(s_["entity_id"]) for s_ in sts)),
            entity_names=[str((s_.get("attributes") or {}).get("friendly_name") or s_["entity_id"]) for s_ in sts],
            has_switch=has_switch, has_light=has_light, outlet=outlet))
        # doors vs windows: Home Assistant's device class decides which page a contact sensor goes on
        dcs = {(x.get("attributes") or {}).get("device_class") for x in sts if x["entity_id"].startswith(("binary_sensor.", "cover."))}
        opening = "window" if "window" in dcs or "shade" in caps else "door" if dcs & {"door", "garage_door", "gate"} else None
        if kind in OWN_OPENINGS:
            # An appliance's "opening" (a water heater's shutoff valve, an oven or washer door) or a car's doors aren't
            # the house's doors: keep them as readings, out of Doors and Security
            for k in [k for k in caps if k == "contact" or k.startswith("contact_")]:
                eid = self.cap_entity.pop((did, k), None)
                suffix = self._switch_suffix(eid or "", next((x for x in sts if x["entity_id"] == eid), {}), str(name)) if eid else None
                new = "opening_" + re.sub(r"[^a-z0-9]+", "_", (suffix or "door").lower()).strip("_")[:24]
                while new in caps:
                    new += "_"
                caps[new] = cap(new, label=(suffix or "Door")[:40])
                values[new] = values.pop(k, None)
                del caps[k]
                if eid:
                    self.cap_entity[(did, new)] = eid
                    self.entity_caps[eid] = {o: (new if c == k else c) for o, c in self.entity_caps.get(eid, {}).items()}
        aq_service = next((OUTDOOR_AQI[d] for d in sorted(self._integrations(first["entity_id"])) if d in OUTDOOR_AQI), None)
        room = self._area_name(first["entity_id"]) or ((self.areas.get(devreg.get("area_id"))) if devreg else None)
        self.hub.upsert_device(Device(id=did, name=str(name)[:80], source=self.source, model=model[:80], room=room, capabilities=caps),
                               replace=True, publish=False)
        attrs = {"ha_entities": [s["entity_id"] for s in sts][:40]}
        ints = sorted(self._main_integrations(first["entity_id"]))
        if ints:                                   # the system it comes from (Hue, Nanoleaf…), for the Lights page tabs
            attrs["integration"] = integration_label(ints[0])
        if opening and ("contact" in caps or "shade" in caps):
            attrs["opening"] = opening
        if kind:
            attrs["kind"] = kind
        if kind == "weather":
            weid = next(s["entity_id"] for s in sts if s["entity_id"].startswith("weather."))
            wa = next((s.get("attributes") or {} for s in sts if s["entity_id"] == weid), {})
            wst = next((s.get("state") for s in sts if s["entity_id"] == weid), "")
            self.weather_attrs[weid], self.weather_state[weid] = dict(wa), wst
            attrs.update(icon=WEATHER_ICON.get(wst, "cloudy"), is_day=wst != "clear-night", place=wa.get("friendly_name"),
                         wind_dir=_num(wa.get("wind_bearing")),
                         units={"wind": wa.get("wind_speed_unit") or "", "rain": wa.get("precipitation_unit") or ""})
            attrs.update(self.forecasts.get(weid) or {})       # the device was re-created: keep its forecast
        elif kind == "aqi_station":
            attrs.update(provider=f"{aq_service} (Home Assistant)", place=room or str(name)[:80])
        if nut:
            attrs["nut_vars"] = nv
        self.hub.set_attributes(did, attrs)
        for s_ in sts:
            self.avail[s_["entity_id"]] = self._eff(s_["entity_id"], s_.get("state")) != "unavailable"
        self.dev_ents[did] = [s_["entity_id"] for s_ in sts]
        self.hub.set_values(did, {k: v for k, v in values.items() if v is not None}, online=any(self.avail[e] for e in self.dev_ents[did]),
                            fresh=False)
        return True

    def _apply(self, eid: str, ns: dict):
        if self._held is not None:                  # a read of the registries is running: apply this after it
            self._held.append((eid, ns))
            return
        did = self.entity_dev[eid]
        if eid in self.entity_nut:
            nut = self.nut_states.setdefault(did, {})
            nut[self.entity_nut[eid]] = (ns.get("state"), ns.get("attributes") or {})
            nv = nut_vars(nut)
            self.hub.set_attributes(did, {"nut_vars": nv})
            self.avail[eid] = ns.get("state") != "unavailable"
            self.hub.set_values(did, parse_status(nv), online=self._device_online(did, eid))
            return
        state = self._eff(eid, ns.get("state"))
        self.avail[eid] = state != "unavailable"
        mapped = self._standby_zero(state != ns.get("state"), map_entity(eid, state, self._attrs(eid, ns.get("attributes"))) or {})
        names = self.entity_caps.get(eid, {})
        vals = {names[c]: v for c, (v, _kw) in mapped.items() if v is not None and c in names}
        if eid.startswith("weather."):
            wa = ns.get("attributes") or {}
            self.weather_attrs[eid] = dict(wa)
            self.hub.set_attributes(did, {"icon": WEATHER_ICON.get(ns.get("state"), "cloudy"), "is_day": ns.get("state") != "clear-night",
                                          "wind_dir": _num(wa.get("wind_bearing"))})
            if ns.get("state") != self.weather_state.get(eid):        # the condition changed: fetch the forecast again
                self.weather_state[eid] = ns.get("state")
                self._forecast_due.add(eid)
                self._forecast_now.set()
        self.hub.set_values(did, vals, online=self._device_online(did, eid))

    # ---------------- weather forecasts ----------------
    async def _forecaster(self):
        """Daily forecasts of the imported weather entities: every FORECAST_SECONDS, and soon after a weather
        entity's condition changes or a new one is imported (Home Assistant no longer puts them in the state)."""
        while True:
            self._forecast_now.clear()
            now = time.monotonic()
            for eid in [e for e in self.entity_dev if e.startswith("weather.")]:
                if eid in self._forecast_due or now - self._forecast_at.get(eid, -FORECAST_SECONDS) >= FORECAST_SECONDS:
                    self._forecast_due.discard(eid)
                    self._forecast_at[eid] = now
                    try:
                        await self.update_forecast(eid)
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:  # noqa: BLE001 - e.g. a weather service without daily forecasts
                        self.log.info("forecast of %s: %s", eid, e)
            try:
                await asyncio.wait_for(self._forecast_now.wait(), 60)
            except asyncio.TimeoutError:
                pass

    async def update_forecast(self, eid: str) -> None:
        res = await self._send({"type": "call_service", "domain": "weather", "service": "get_forecasts",
                                "service_data": {"type": "daily"}, "target": {"entity_id": eid},
                                "return_response": True}, timeout=30)
        resp = (res or {}).get("response") if isinstance(res, dict) else None
        items = ((resp or {}).get(eid) or {}).get("forecast") if isinstance(resp, dict) else None
        fc = parse_forecast(items, self.weather_attrs.get(eid) or {})
        self.forecasts[eid] = fc
        did = self.entity_dev.get(eid)
        if did in self.hub.devices:
            self.hub.set_attributes(did, fc, publish=True)

    # ---------------- control ----------------
    @staticmethod
    def _switch_suffix(eid: str, st: dict, device_name: str) -> str | None:
        """The part of a switch's name after its device's name ("Front Camera Siren" -> "Siren"), or None when the
        switch is the device itself (a plug's on/off)."""
        fn = str((st.get("attributes") or {}).get("friendly_name") or "").strip()
        dn = device_name.strip()
        if eid.startswith("siren."):
            rest = fn[len(dn):].strip(" -_:·") if dn and fn.lower().startswith(dn.lower()) else ""
            return rest or "Siren"
        if not fn or not dn or fn.lower() == dn.lower():
            return None
        if fn.lower().startswith(dn.lower()):
            rest = fn[len(dn):].strip(" -_:·")
            return None if rest.lower() in ("", "switch", "power", "outlet", "plug", "relay") else rest
        return None

    def _climate_temps(self, device: Device, capability: str, value: Any) -> dict:
        """climate.set_temperature data for one changed setpoint (°C from Haven). A range thermostat always gets
        both ends, kept at least 1.5 °C apart (most thermostats refuse a narrower gap)."""
        try:
            v = float(value)
        except (TypeError, ValueError):
            raise ValueError("temperature must be a number") from None
        cp = device.capabilities[capability]
        if cp.min is not None and cp.max is not None:
            v = max(float(cp.min), min(float(cp.max), v))
        u = self.temp_unit
        if capability == "target_temperature":
            return {"temperature": _ha_temp(v, u)}
        heat = device.capabilities.get("heat_setpoint")
        cool = device.capabilities.get("cool_setpoint")
        lo = v if capability == "heat_setpoint" else (heat.value if heat and heat.value is not None else v - 2)
        hi = v if capability == "cool_setpoint" else (cool.value if cool and cool.value is not None else v + 2)
        if hi - lo < 1.5:
            lo, hi = (hi - 1.5, hi) if capability == "cool_setpoint" else (lo, lo + 1.5)
        return {"target_temp_low": _ha_temp(lo, u), "target_temp_high": _ha_temp(hi, u)}

    async def command(self, device: Device, capability: str, value: Any):
        eid = self.cap_entity.get((device.id, capability))
        if not eid or self.ws is None:
            raise RuntimeError("not connected to Home Assistant")
        domain = eid.split(".")[0]
        # a second reading of the same kind was renamed (action_right, brightness_b…): control it by its original name
        capability = next((o for o, c in self.entity_caps.get(eid, {}).items() if c == capability), capability)
        base = capability.split("_")[0] if capability not in ("alarm_panel", "fan_speed", "color_temp") else capability
        data: dict[str, Any] = {}
        if base in SERVICE:
            sdomain, service, data = SERVICE[base](value)
        elif capability in ("light", "switch") or base in ("light", "switch"):
            sdomain, service = domain, "turn_on" if value else "turn_off"   # switch.*, input_boolean.*, siren.*
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
        elif domain == "climate" and capability in ("hvac_mode", "fan_mode"):
            opts = device.capabilities[capability].options or []
            if value not in opts:
                raise ValueError(f"{capability} must be one of {', '.join(opts)}")
            sdomain, service, data = "climate", f"set_{capability}", {capability: value}
        elif domain == "climate" and capability in ("target_temperature", "heat_setpoint", "cool_setpoint"):
            sdomain, service, data = "climate", "set_temperature", self._climate_temps(device, capability, value)
        elif capability == "position" and domain == "cover":
            sdomain, service, data = "cover", "set_cover_position", {"position": max(0, min(100, int(float(value))))}
        elif capability == "action" and domain == "cover":
            sdomain, service = "cover", {"open": "open_cover", "close": "close_cover", "stop": "stop_cover"}[value]
        else:
            raise ValueError(f"{capability} can't be controlled")
        await self._send({"type": "call_service", "domain": sdomain, "service": service,
                          "target": {"entity_id": eid}, "service_data": data}, timeout=20)


def _ha_temp(c: float, unit: str) -> float:
    """°C (Haven) to Home Assistant's unit: whole °F, or °C to the half degree."""
    return round(c * 9 / 5 + 32) if unit.upper().endswith("F") else round(c * 2) / 2


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
        {"key": "skip_integrations", "label": "Integrations to show", "type": "toggles", "mode": "off", "default": [],
         "help": "Everything Haven found in Home Assistant, with how many devices each brings. Turn one off and its "
                 "devices leave Haven at the next refresh (nothing changes in Home Assistant)."},
        {"key": "domains", "label": "Kinds of data to import", "type": "toggles", "mode": "on",
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
