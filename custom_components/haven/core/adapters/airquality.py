"""Outdoor air quality by ZIP / postal code.

Providers
- open-meteo (default, free, no key): the postal code is geocoded with zippopotam.us (fallback:
  Open-Meteo geocoding), then the Open-Meteo Air Quality API gives US AQI plus pollutant
  concentrations (PM2.5, PM10, ozone, NO2, SO2, CO, dust) and UV index, with an hourly forecast.
- airnow (US EPA, free API key from docs.airnowapi.org): official reporting-area AQI per
  pollutant (PM2.5, PM10, O3) for the ZIP; overall AQI = the highest one; daily forecast.

One device per ZIP ("airquality:<zip>") in room "Outdoor", refreshed every poll_minutes (60).
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any

import httpx

from ..models import Device, cap
from .base import Adapter

GEO_ZIPPO = "https://api.zippopotam.us/{country}/{zip}"
GEO_OPENMETEO = "https://geocoding-api.open-meteo.com/v1/search"
OPENMETEO_AQ = "https://air-quality-api.open-meteo.com/v1/air-quality"
AIRNOW_OBS = "https://www.airnowapi.org/aq/observation/zipCode/current/"
AIRNOW_FC = "https://www.airnowapi.org/aq/forecast/zipCode/"

OM_CURRENT = ["us_aqi", "pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide", "carbon_monoxide",
              "uv_index", "dust", "us_aqi_pm2_5", "us_aqi_pm10", "us_aqi_ozone", "us_aqi_nitrogen_dioxide",
              "us_aqi_sulphur_dioxide", "us_aqi_carbon_monoxide"]
# Open-Meteo variable -> (capability, unit, label)
OM_MAP = {
    "us_aqi": ("aqi", None, "AQI"),
    "pm2_5": ("pm25", "µg/m³", "PM2.5"),
    "pm10": ("pm10", "µg/m³", "PM10"),
    "ozone": ("ozone", "µg/m³", "Ozone"),
    "nitrogen_dioxide": ("no2", "µg/m³", "NO₂"),
    "sulphur_dioxide": ("so2", "µg/m³", "SO₂"),
    "carbon_monoxide": ("co", "µg/m³", "CO"),
    "uv_index": ("uv", None, "UV index"),
    "dust": ("dust", "µg/m³", "Dust"),
}
# per-pollutant US AQI sub-index -> readable pollutant name (for "dominant")
OM_SUB = {"us_aqi_pm2_5": "PM2.5", "us_aqi_pm10": "PM10", "us_aqi_ozone": "Ozone", "us_aqi_nitrogen_dioxide": "NO₂",
          "us_aqi_sulphur_dioxide": "SO₂", "us_aqi_carbon_monoxide": "CO"}
# AirNow ParameterName -> (capability, label)
AIRNOW_MAP = {"PM2.5": ("pm25_aqi", "PM2.5 (AQI)"), "PM10": ("pm10_aqi", "PM10 (AQI)"), "O3": ("ozone_aqi", "Ozone (AQI)"),
              "OZONE": ("ozone_aqi", "Ozone (AQI)")}


def category(aqi: float | None) -> str | None:
    """US EPA AQI category name."""
    if aqi is None:
        return None
    a = round(aqi)
    if a <= 50:
        return "Good"
    if a <= 100:
        return "Moderate"
    if a <= 150:
        return "Unhealthy for sensitive groups"
    if a <= 200:
        return "Unhealthy"
    if a <= 300:
        return "Very unhealthy"
    return "Hazardous"


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f   # NaN


def parse_open_meteo(data: dict, now: float | None = None) -> dict:
    """Return {"values": {cap: value}, "units": {...}, "labels": {...}, "dominant": str|None,
    "observed": epoch|None, "forecast": [{"t", "aqi"}]} from an Open-Meteo air-quality response
    requested with timeformat=unixtime."""
    now = time.time() if now is None else now
    cur = data.get("current") or {}
    values, units, labels = {}, {}, {}
    for var, (capname, unit, label) in OM_MAP.items():
        v = _num(cur.get(var))
        if v is None:
            continue
        values[capname] = int(round(v)) if capname == "aqi" else round(v, 1)
        units[capname], labels[capname] = unit, label
    subs = {name: _num(cur.get(var)) for var, name in OM_SUB.items()}
    subs = {k: v for k, v in subs.items() if v is not None}
    dominant = max(subs, key=subs.get) if subs else None
    observed = _num(cur.get("time"))
    hourly = data.get("hourly") or {}
    times, aqis = hourly.get("time") or [], hourly.get("us_aqi") or []
    forecast = [{"t": int(t), "aqi": int(round(a))} for t, a in zip(times, aqis, strict=False)
                if _num(a) is not None and _num(t) is not None and now - 3600 <= float(t) <= now + 24 * 3600]
    return {"values": values, "units": units, "labels": labels, "dominant": dominant,
            "observed": int(observed) if observed else None, "forecast": forecast}


def parse_airnow(obs: list, fc: list | None = None) -> dict:
    """AirNow current observations (+ optional forecast) → same shape as parse_open_meteo."""
    values, units, labels, per = {}, {}, {}, {}
    observed, area = None, None
    for o in obs or []:
        name = str(o.get("ParameterName", "")).upper().replace("OZONE", "O3")
        aqi = _num(o.get("AQI"))
        if aqi is None or aqi < 0:
            continue
        capname, label = AIRNOW_MAP.get(name, AIRNOW_MAP.get(o.get("ParameterName", ""), (None, None)))
        if not capname:
            continue
        values[capname], units[capname], labels[capname] = int(aqi), None, label
        per[{"O3": "Ozone"}.get(name, name)] = aqi
        area = area or o.get("ReportingArea")
        try:
            d = datetime.strptime(f"{o.get('DateObserved', '').strip()} {int(o.get('HourObserved', 0)):02d}", "%Y-%m-%d %H")
            observed = observed or int(d.timestamp())
        except (ValueError, TypeError):
            pass
    dominant = max(per, key=per.get) if per else None
    if per:
        values["aqi"], units["aqi"], labels["aqi"] = int(max(per.values())), None, "AQI"
    forecast = []
    for f in fc or []:
        aqi = _num(f.get("AQI"))
        if aqi is None or aqi < 0:
            # AirNow sometimes only gives a category for forecasts; use the category's midpoint
            num = (f.get("Category") or {}).get("Number")
            aqi = {1: 25, 2: 75, 3: 125, 4: 175, 5: 250, 6: 350}.get(num)
        try:
            t = int(datetime.strptime(str(f.get("DateForecast", "")).strip(), "%Y-%m-%d").timestamp())
        except ValueError:
            continue
        if aqi is not None:
            forecast.append({"t": t, "aqi": int(aqi)})
    # keep the highest AQI per day (one entry per pollutant is returned)
    best: dict[int, int] = {}
    for x in forecast:
        best[x["t"]] = max(best.get(x["t"], 0), x["aqi"])
    return {"values": values, "units": units, "labels": labels, "dominant": dominant, "observed": observed,
            "forecast": [{"t": t, "aqi": a} for t, a in sorted(best.items())], "area": area}


class AirQualityAdapter(Adapter):
    source = "airquality"

    def __init__(self, hub, cfg, transport: httpx.AsyncBaseTransport | None = None):
        super().__init__(hub, cfg)
        self.provider = str(cfg.get("provider") or "open-meteo").lower()
        self.zip = str(cfg.get("zip_code") or "").strip()
        self.country = str(cfg.get("country") or "US").strip().upper() or "US"
        self.key = str(cfg.get("airnow_api_key") or "").strip()
        try:
            self.poll = max(15, float(cfg.get("poll_minutes") or 60)) * 60
        except (TypeError, ValueError):
            self.poll = 3600
        self.name = str(cfg.get("name") or "Outdoor air").strip() or "Outdoor air"
        self.http = httpx.AsyncClient(timeout=20, transport=transport,
                                      headers={"User-Agent": "Haven home dashboard (github.com/ryanbyte1701/haven)"})
        self.geo: dict | None = None      # {"lat", "lon", "place"}
        self.did = self.dev_id(self.zip or "unset")

    async def start(self):
        if not self.zip:
            self.status = "needs a ZIP code (Settings > Outdoor air quality)"
            return
        if self.provider == "airnow" and not self.key:
            self.status = "needs an AirNow API key (free at docs.airnowapi.org), or switch provider to Open-Meteo"
            return
        self.spawn("poll", self._loop, max_delay=900)

    async def stop(self):
        await super().stop()
        await self.http.aclose()

    async def _loop(self):
        while True:
            await self.refresh()
            await asyncio.sleep(self.poll)

    # ---------------- providers ----------------
    async def geocode(self) -> dict:
        if self.geo:
            return self.geo
        r = await self.http.get(GEO_ZIPPO.format(country=self.country.lower(), zip=self.zip))
        if r.status_code == 200 and (r.json().get("places") or []):
            p = r.json()["places"][0]
            place = ", ".join(x for x in (p.get("place name"), p.get("state abbreviation")) if x)
            self.geo = {"lat": float(p["latitude"]), "lon": float(p["longitude"]), "place": place or self.zip}
            return self.geo
        r = await self.http.get(GEO_OPENMETEO, params={"name": self.zip, "count": 1, "country": self.country, "format": "json"})
        r.raise_for_status()
        res = (r.json().get("results") or [])
        if not res:
            raise RuntimeError(f"couldn't find ZIP/postal code {self.zip} ({self.country})")
        g = res[0]
        place = ", ".join(x for x in (g.get("name"), g.get("admin1")) if x)
        self.geo = {"lat": float(g["latitude"]), "lon": float(g["longitude"]), "place": place or self.zip}
        return self.geo

    async def fetch_open_meteo(self) -> dict:
        g = await self.geocode()
        r = await self.http.get(OPENMETEO_AQ, params={
            "latitude": g["lat"], "longitude": g["lon"], "current": ",".join(OM_CURRENT),
            "hourly": "us_aqi,pm2_5,ozone", "forecast_days": 2, "timezone": "auto", "timeformat": "unixtime"})
        r.raise_for_status()
        out = parse_open_meteo(r.json())
        out["place"] = g["place"]
        return out

    async def fetch_airnow(self) -> dict:
        p = {"format": "application/json", "zipCode": self.zip, "distance": 25, "API_KEY": self.key}
        r = await self.http.get(AIRNOW_OBS, params=p)
        if r.status_code in (401, 403):
            raise RuntimeError("AirNow rejected the API key")
        r.raise_for_status()
        obs = r.json()
        fc = []
        try:
            rf = await self.http.get(AIRNOW_FC, params=p)
            if rf.status_code == 200:
                fc = rf.json()
        except httpx.HTTPError:
            pass
        out = parse_airnow(obs, fc)
        if not out["values"]:
            raise RuntimeError(f"AirNow has no current data within 25 miles of {self.zip}")
        if obs:
            o = obs[0]
            out["place"] = ", ".join(x for x in (o.get("ReportingArea"), o.get("StateCode")) if x) or self.zip
            if self.geo is None and o.get("Latitude") is not None:
                self.geo = {"lat": o.get("Latitude"), "lon": o.get("Longitude"), "place": out["place"]}
        return out

    async def refresh(self) -> None:
        data = await (self.fetch_airnow() if self.provider == "airnow" else self.fetch_open_meteo())
        place = data.get("place") or self.zip
        caps = {}
        for capname in data["values"]:
            caps[capname] = cap(capname, unit=data["units"].get(capname), label=data["labels"].get(capname))
        caps["status_text"] = cap("status_text")
        dev = self.hub.devices.get(self.did)
        if dev is None or set(caps) - set(dev.capabilities):
            self.hub.upsert_device(Device(id=self.did, name=f"{self.name} ({place})", source=self.source,
                                          model="Open-Meteo" if self.provider != "airnow" else "AirNow (EPA)",
                                          room="Outdoor", capabilities=caps))
        self.hub.set_attributes(self.did, {
            "kind": "aqi_station", "provider": self.provider, "place": place,
            "lat": (self.geo or {}).get("lat"), "lon": (self.geo or {}).get("lon"),
            "observed": data.get("observed"), "dominant": data.get("dominant"), "forecast": data.get("forecast") or []})
        values = dict(data["values"])
        values["status_text"] = category(values.get("aqi")) or "No data"
        self.hub.set_values(self.did, values, online=True)
        self.status = f"ok · AQI {values.get('aqi', '–')} ({values['status_text']})"


ADAPTER = AirQualityAdapter
SETTINGS = {
    "id": "airquality", "label": "Outdoor air quality", "icon": "aq",
    "help": "Outdoor AQI and pollutants for your ZIP / postal code, refreshed every hour. Open-Meteo works "
            "worldwide with no account (modelled data, includes PM2.5, PM10, ozone, NO₂, SO₂, CO, dust and UV). "
            "AirNow is the US EPA's official reporting-area AQI: get a free API key at docs.airnowapi.org.",
    "fields": [
        {"key": "zip_code", "label": "ZIP / postal code", "type": "text"},
        {"key": "country", "label": "Country code", "type": "text", "default": "US"},
        {"key": "provider", "label": "Data source", "type": "select", "default": "open-meteo", "options": ["open-meteo", "airnow"]},
        {"key": "airnow_api_key", "label": "AirNow API key (only for AirNow)", "type": "password"},
        {"key": "name", "label": "Name", "type": "text", "default": "Outdoor air"},
        {"key": "poll_minutes", "label": "Refresh every (minutes)", "type": "number", "default": 60},
    ],
}
