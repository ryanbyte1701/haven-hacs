"""Local weather and forecast by ZIP / postal code (Open-Meteo, free, no key).

One device ("weather:<zip>", room Outdoor, kind "weather") with current conditions (temperature,
feels-like, humidity, wind, gusts, UV, pressure, precipitation, condition) and a daily forecast
in its attributes for the Home page. If the ZIP is left empty, the one from Outdoor air quality
is used. Refreshed every poll_minutes (default 15).
"""
from __future__ import annotations

import asyncio
import math
from typing import Any

import httpx

from ..models import Device, cap
from .airquality import AirQualityAdapter
from .base import Adapter

FORECAST = "https://api.open-meteo.com/v1/forecast"
CURRENT = ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "weather_code", "is_day",
           "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "precipitation", "uv_index", "pressure_msl"]
DAILY = ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
         "precipitation_sum", "sunrise", "sunset", "uv_index_max"]

# WMO weather interpretation codes -> (text, icon key used by the UI)
WMO = {
    0: ("Clear", "clear"), 1: ("Mostly clear", "clear"), 2: ("Partly cloudy", "partly"), 3: ("Cloudy", "cloudy"),
    45: ("Fog", "fog"), 48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "rain"), 53: ("Drizzle", "rain"), 55: ("Heavy drizzle", "rain"),
    56: ("Freezing drizzle", "sleet"), 57: ("Freezing drizzle", "sleet"),
    61: ("Light rain", "rain"), 63: ("Rain", "rain"), 65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "sleet"), 67: ("Freezing rain", "sleet"),
    71: ("Light snow", "snow"), 73: ("Snow", "snow"), 75: ("Heavy snow", "snow"), 77: ("Snow grains", "snow"),
    80: ("Showers", "rain"), 81: ("Showers", "rain"), 82: ("Heavy showers", "rain"),
    85: ("Snow showers", "snow"), 86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "storm"), 96: ("Thunderstorm, hail", "storm"), 99: ("Thunderstorm, hail", "storm"),
}


def condition(code: Any) -> tuple[str, str]:
    try:
        return WMO.get(int(code), ("—", "cloudy"))
    except (TypeError, ValueError):
        return ("—", "cloudy")


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def parse_forecast(data: dict, imperial: bool) -> dict:
    cur = data.get("current") or {}
    text, kind = condition(cur.get("weather_code"))
    vals: dict[str, Any] = {
        "temperature": _num(cur.get("temperature_2m")),             # always °C (the UI converts)
        "feels_like": _num(cur.get("apparent_temperature")),
        "humidity": _num(cur.get("relative_humidity_2m")),
        "wind_speed": _num(cur.get("wind_speed_10m")),
        "wind_gust": _num(cur.get("wind_gusts_10m")),
        "uv": _num(cur.get("uv_index")),
        "pressure": _num(cur.get("pressure_msl")),
        "precipitation": _num(cur.get("precipitation")),
        "status_text": text,
    }
    vals = {k: v for k, v in vals.items() if v is not None}
    d = data.get("daily") or {}
    days = []
    for i, t in enumerate(d.get("time") or []):
        def at(key):
            arr = d.get(key) or []
            return arr[i] if i < len(arr) else None
        t_text, t_kind = condition(at("weather_code"))
        days.append({"t": t, "text": t_text, "icon": t_kind, "hi": _num(at("temperature_2m_max")),
                     "lo": _num(at("temperature_2m_min")), "pop": _num(at("precipitation_probability_max")),
                     "rain": _num(at("precipitation_sum")), "uv": _num(at("uv_index_max")),
                     "sunrise": at("sunrise"), "sunset": at("sunset")})
    return {"values": vals, "icon": kind, "is_day": bool(cur.get("is_day", 1)), "wind_dir": _num(cur.get("wind_direction_10m")),
            "daily": days[:7], "units": {"wind": "mph" if imperial else "km/h", "rain": "in" if imperial else "mm"}}


class WeatherAdapter(Adapter):
    source = "weather"

    def __init__(self, hub, cfg, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__(hub, cfg)
        self.zip = str(cfg.get("zip_code") or "").strip()
        self.country = str(cfg.get("country") or "").strip().upper()
        try:
            self.poll = max(5, float(cfg.get("poll_minutes") or 15)) * 60
        except (TypeError, ValueError):
            self.poll = 900
        self.name = str(cfg.get("name") or "Weather").strip()[:60] or "Weather"
        self.transport = transport
        self.http = httpx.AsyncClient(timeout=20, transport=transport,
                                      headers={"User-Agent": "Haven home dashboard (github.com/ryanbyte1701/haven)"})
        self._geo_helper: AirQualityAdapter | None = None

    def _location(self) -> tuple[str, str]:
        if self.zip:
            return self.zip, self.country or "US"
        aq = self.hub.adapters.get("airquality") if self.hub else None
        if aq is not None and getattr(aq, "zip", ""):
            return aq.zip, self.country or getattr(aq, "country", "US")
        return "", self.country or "US"

    async def start(self):
        self.spawn("poll", self._loop, max_delay=900)

    async def stop(self):
        await super().stop()
        await self.http.aclose()
        if self._geo_helper:
            await self._geo_helper.http.aclose()

    async def _loop(self):
        while True:
            zip_, country = self._location()
            if not zip_:
                self.status = "needs a ZIP code (here, or in Settings > Outdoor air quality)"
                await asyncio.sleep(60)
                continue
            await self.refresh(zip_, country)
            await asyncio.sleep(self.poll)

    async def geocode(self, zip_: str, country: str) -> dict:
        h = self._geo_helper
        if h is None or h.zip != zip_ or h.country != country:
            if h:
                await h.http.aclose()
            h = self._geo_helper = AirQualityAdapter(None, {"zip_code": zip_, "country": country}, transport=self.transport)
        return await h.geocode()

    async def refresh(self, zip_: str, country: str) -> None:
        g = await self.geocode(zip_, country)
        imperial = country == "US"
        r = await self.http.get(FORECAST, params={
            "latitude": g["lat"], "longitude": g["lon"], "current": ",".join(CURRENT), "daily": ",".join(DAILY),
            "forecast_days": 6, "timezone": "auto", "timeformat": "unixtime",
            "wind_speed_unit": "mph" if imperial else "kmh", "precipitation_unit": "inch" if imperial else "mm"})
        r.raise_for_status()
        w = parse_forecast(r.json(), imperial)
        did = self.dev_id(zip_)
        units = {"wind_speed": w["units"]["wind"], "wind_gust": w["units"]["wind"], "precipitation": w["units"]["rain"],
                 "pressure": "hPa", "uv": None, "humidity": "%"}
        labels = {"feels_like": "Feels like", "wind_speed": "Wind", "wind_gust": "Gust", "uv": "UV",
                  "precipitation": "Rain now", "status_text": "Conditions"}
        caps = {k: cap(k, unit=units.get(k, cap(k).unit if k != "feels_like" else "°C"), label=labels.get(k)) for k in w["values"]}
        dev = self.hub.devices.get(did)
        if dev is None or set(caps) - set(dev.capabilities):
            self.hub.upsert_device(Device(id=did, name=f"{self.name} ({g['place']})", source=self.source, model="Open-Meteo",
                                          room="Outdoor", capabilities=caps))
        self.hub.set_attributes(did, {"kind": "weather", "place": g["place"], "icon": w["icon"], "is_day": w["is_day"],
                                      "wind_dir": w["wind_dir"], "daily": w["daily"], "units": w["units"]})
        self.hub.set_values(did, w["values"], online=True)
        self.status = f"ok · {w['values'].get('status_text', '')} {round(w['values'].get('temperature', 0))}°C"


ADAPTER = WeatherAdapter
SETTINGS = {
    "id": "weather", "label": "Weather forecast", "icon": "partly_cloudy_day",
    "help": "Current conditions and a 6-day forecast for the Home page, from Open-Meteo (free, no account). "
            "Leave the ZIP empty to use the one from Outdoor air quality. If you have an Ecowitt weather "
            "station, the Home page shows its readings next to the forecast.",
    "fields": [
        {"key": "zip_code", "label": "ZIP / postal code (optional)", "type": "text"},
        {"key": "country", "label": "Country code (US = °F, mph, inches)", "type": "text", "default": "US"},
        {"key": "name", "label": "Name", "type": "text", "default": "Weather"},
        {"key": "poll_minutes", "label": "Refresh every (minutes)", "type": "number", "default": 15},
    ],
}
