"""What kind of device a Home Assistant device is: one ordered table of rules.

Haven groups devices by kind (Cars, Network, Appliances, smoke alarms, smart plugs…) and some kinds change how a
device is shown (a car's door sensors aren't house doors; a plug goes on the Power page). Home Assistant doesn't say
"this is a car", so the kind is worked out from what we do know about a device:

  * integrations - the Home Assistant integrations it comes from (e.g. "kia_uvo", "unifi", "xsense")
  * caps / values - the readings Haven made of its entities (map_entity in homeassistant.py)
  * name / model - from Home Assistant's device registry
  * entity_names - its entities' friendly names (e.g. "Odometer", "Fuel level")
  * domains, has_switch, has_light, outlet - its entity domains and what its switches are

RULES is checked top to bottom and the first match wins. To teach Haven a new kind of device, add a rule (or add
an integration to one of the sets below) and a test in tests/test_homeassistant.py.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

# ---- integrations that tell what a device is ----
VEHICLE_DOMAINS = {
    "kia_uvo", "hyundai_kia_connect", "hyundai_bluelink", "bluelink", "genesis",            # Hyundai / Kia / Genesis
    "tesla_fleet", "teslemetry", "tessie", "tesla_custom", "tesla",                       # Tesla
    "bmw_connected_drive", "mbapi2020", "mercedes_me", "volvo", "volvooncall", "polestar_api", "renault",
    "nissan_leaf", "toyota", "mytoyota", "lexus", "subaru", "mazda", "fordpass", "ford", "volkswagen_we_connect_id",
    "volkswagencarnet", "audiconnect", "myskoda", "skodaconnect", "cupra_we_connect", "rivian", "smartcar",
    "porsche", "honda", "jlrincontrol", "mg_saic", "byd", "leapmotor",
}
NETWORK_DOMAINS = {
    "unifi", "tplink_omada", "tplink_deco", "tplink_router", "netgear", "netgear_lte", "fritz", "fritzbox_callmonitor",
    "asuswrt", "asusrouter", "openwrt", "luci", "ubus", "mikrotik", "pfsense", "opnsense", "keenetic_ndms2", "huawei_lte",
    "zyxel", "eero", "google_wifi", "starlink", "upnp", "speedtestdotnet", "fastdotcom", "ping", "snmp", "synology_dsm",
    "qnap", "qnap_qsw", "glances", "netdata", "nmap_tracker", "plume", "orbi", "linksys_smart", "sky_hub", "vodafone_station",
}
APPLIANCE_DOMAINS = {
    "home_connect", "miele", "lg_thinq", "smartthinq_sensors", "whirlpool", "electrolux", "electrolux_status", "ge_home",
    "hon", "haier", "aeg", "frigidaire", "bosch_shc_appliances", "samsung_family_hub", "smartthings_appliances",
    "rinnai", "aosmith", "econet", "sensibo", "midea_ac_lan", "midea_dehumidifier_lan", "gree", "daikin", "fujitsu_hvac",
    "dreame_vacuum", "ecovacs", "sharkiq", "irobot", "roomba", "neato", "eufy_robovac", "roborock",
}
SMOKE_DOMAINS = {"xsense", "kidde", "kidde_homesafe", "onelink", "nest_protect", "netatmo_smoke", "smoke_alarm", "fireangel"}
# outdoor air-quality services (their devices are stations, not rooms): integration -> name shown
OUTDOOR_AQI = {"airnow": "AirNow", "waqi": "WAQI", "airvisual": "IQAir AirVisual", "google_air_quality": "Google Air Quality",
               "purpleair": "PurpleAir", "luftdaten": "Sensor.Community", "airly": "Airly"}

# ---- names and models ----
VEHICLE_HINT = re.compile(r"odometer|mileage|driving range|ev range|fuel level|charge port|trunk|tire|tyre", re.I)
APPLIANCE_HINT = re.compile(r"washer|washing|dryer|dishwasher|fridge|refrigerator|freezer|oven|range hood|cooktop|"
                            r"microwave|coffee|espresso|kettle|ice maker|water heater|dehumidifier|humidifier", re.I)
SMOKE_HINT = re.compile(r"\bsmoke\b|carbon monoxide|\bco ?(alarm|detector)|fire alarm|nest protect|\bxs0\d|\bsc0\d", re.I)
PLUG_MODEL = re.compile(r"\b(P1\d\d\w*|P3\d\d\w*|TP25\w*|KP\d+\w*|HS1\d\d\w*|EP\d+\w*|HS300|KP\d+)\b|plug|outlet|strip", re.I)

# ---- single entities (used by map_entity) ----
SMOKE_TEXT = {"alarm": True, "detected": True, "smoke": True, "emergency": True, "warning": True, "fire": True,
              "normal": False, "clear": False, "ok": False, "idle": False, "standby": False, "no_smoke": False, "off": False}
SHADE_CLASSES = {"blind", "shade", "curtain", "awning", "shutter"}
SHADE_HINT = re.compile(r"blind|shade|curtain|drape|awning|shutter|roller", re.I)
# kinds whose door/contact sensors aren't the house's doors (kept as readings, out of Doors and Security)
OWN_OPENINGS = {"appliance", "vehicle", "network"}


@dataclass
class DeviceFacts:
    name: str = ""
    model: str = ""
    integrations: set[str] = field(default_factory=set)
    caps: set[str] = field(default_factory=set)
    values: dict[str, Any] = field(default_factory=dict)
    entity_names: list[str] = field(default_factory=list)
    domains: set[str] = field(default_factory=set)
    has_switch: bool = False
    has_light: bool = False
    outlet: bool = False

    @property
    def label(self) -> str:
        return f"{self.name} {self.model}"


def _vehicle(f: DeviceFacts) -> bool:
    return bool(f.integrations & VEHICLE_DOMAINS) or (
        len(f.entity_names) >= 3 and len(VEHICLE_HINT.findall(" ".join(f.entity_names))) >= 2)


def _smoke(f: DeviceFacts) -> bool:
    return ("smoke" in f.caps or ("co" in f.caps and isinstance(f.values.get("co"), bool))
            or bool(f.integrations & SMOKE_DOMAINS) or bool(SMOKE_HINT.search(f.label)))


def _smart_plug(f: DeviceFacts) -> bool:
    # TP-Link/Tapo, Shelly Plug, Kasa…: a switch with an outlet device class, a plug model, or its own power/energy
    return f.has_switch and not f.has_light and (
        f.outlet or bool(PLUG_MODEL.search(f.label)) or any(c.split("_")[0] in ("power", "energy") for c in f.caps))


# (kind, rule) - first match wins
RULES: list[tuple[str, Callable[[DeviceFacts], bool]]] = [
    ("weather", lambda f: "weather" in f.domains),
    ("light", lambda f: "light" in f.domains),
    ("vehicle", _vehicle),
    ("network", lambda f: bool(f.integrations & NETWORK_DOMAINS)),
    ("smoke_alarm", _smoke),
    ("appliance", lambda f: bool(f.integrations & APPLIANCE_DOMAINS) or bool(APPLIANCE_HINT.search(f.label))),
    ("smart_plug", _smart_plug),
    ("aqi_station", lambda f: "aqi" in f.caps and bool(f.integrations & set(OUTDOOR_AQI))),
    ("shade", lambda f: "shade" in f.caps),
]


def classify(facts: DeviceFacts) -> str | None:
    """The device's kind, or None when no rule matches (Haven then goes by its readings alone)."""
    return next((kind for kind, rule in RULES if rule(facts)), None)
