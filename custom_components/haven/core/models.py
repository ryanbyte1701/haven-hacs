"""Normalized device model shared by every adapter.

Every vendor's device is reduced to a Device with a set of named capabilities.
Internal units: temperature is always °C (the UI converts to °F), percentages 0-100.

Capability names used by the UI:
  sensors   temperature humidity moisture pressure illuminance co2 pm25 battery
            wind_speed wind_gust wind_dir rain_rate rain_daily uv solar co_ppm power
  binary    contact ("open"/"closed")  leak motion presence smoke co heat alarm
            battery_low vibration tamper (bool)
  controls  lock ("locked"/"unlocked", cmd "lock"/"unlock")
            valve ("open"/"closed",   cmd "open"/"close")
            switch (bool,              cmd true/false)
            action (no state,          cmd one of options, e.g. "test", "mute", "siren")
            alarm_panel ("disarmed"/"armed_home"/"armed_away"/"triggered"/..., cmd "disarm"/"arm_home"/"arm_away")
  ups       ups_status ("online"/"on_battery"/"low_battery"/"offline")  runtime (min)  load (%)
            input_voltage output_voltage (V)
  ring      ding (doorbell pressed, bool)  light (switch-like floodlight)
  lights    light (bool, cmd true/false)  brightness (0-100 %, cmd 1-100)
            color_temp (Kelvin, cmd Kelvin; attributes ct_min/ct_max)  color ("#rrggbb", cmd "#rrggbb")
            attributes kind = "light" | "group", members = [device ids] for groups
"""
from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, Field


class Capability(BaseModel):
    name: str
    value: Any = None
    unit: str | None = None
    writable: bool = False
    options: list[str] | None = None
    min: float | None = None       # numeric controls (sliders): range and step
    max: float | None = None
    step: float | None = None
    label: str | None = None
    updated: float | None = None


class Device(BaseModel):
    id: str
    name: str
    source: str
    model: str | None = None
    room: str | None = None
    hidden: bool = False
    # Built-in tabs this device should appear in, set by the user on the Devices page.
    # None = automatic (decided from the device's capabilities).
    categories: list[str] | None = None
    online: bool = True
    last_seen: float = Field(default_factory=time.time)
    capabilities: dict[str, Capability] = Field(default_factory=dict)
    attributes: dict[str, Any] = Field(default_factory=dict)   # extra read-only details (UPS vars, Ring info)


# Helpers adapters use to declare capabilities consistently
UNITS = {
    "temperature": "°C", "humidity": "%", "moisture": "%", "battery": "%",
    "pressure": "hPa", "illuminance": "lx", "co2": "ppm", "pm25": "µg/m³",
    "co_ppm": "ppm", "power": "W", "runtime": "min", "load": "%",
    "input_voltage": "V", "output_voltage": "V", "brightness": "%", "color_temp": "K",
}


def cap(name: str, **kw) -> Capability:
    if name == "lock":
        kw.setdefault("writable", True)
        kw.setdefault("options", ["lock", "unlock"])
    elif name == "valve":
        kw.setdefault("writable", True)
        kw.setdefault("options", ["open", "close"])
    elif name == "switch":
        kw.setdefault("writable", True)
    elif name in ("action", "light", "brightness", "color_temp", "color"):
        kw.setdefault("writable", True)
    elif name == "alarm_panel":
        kw.setdefault("writable", True)
        kw.setdefault("options", ["disarm", "arm_home", "arm_away"])
    kw.setdefault("unit", UNITS.get(name))
    return Capability(name=name, **kw)


def f_to_c(f: Any) -> float | None:
    try:
        return round((float(f) - 32) * 5 / 9, 2)
    except (TypeError, ValueError):
        return None
