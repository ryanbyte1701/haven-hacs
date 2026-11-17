"""Account settings edited from the Settings page.

Saved to /data/settings.json (readable only by the container user) and layered over
config.yaml: a value saved here wins over the same value in config.yaml. Passwords and keys
are never sent back to the browser; the UI only learns whether one is set.
"""
from __future__ import annotations

import copy
import ipaddress
import math
import os
import json
import re
from typing import Any

from .config import DATA_DIR, conf_dir, load_config, write_private  # noqa: F401 - DATA_DIR: tests point it at a temp folder

SETTINGS_FILE = conf_dir() / "settings.json"
MASK = "********"
MAX_SECRET_LEN = 4096
MAX_TEXT_LEN = 500
_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


def valid_host(h) -> bool:
    """A bare IP literal or hostname (no scheme, port, path, userinfo or spaces). Used for hosts
    that end up in a URL like https://{host}/api."""
    if not isinstance(h, str) or not h:
        return False
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        pass
    return bool(_HOSTNAME.fullmatch(h)) and not h.startswith(("-", ".")) and ".." not in h


def url_host(h: str) -> str:
    """Host as it goes inside a URL (IPv6 literals in brackets)."""
    return f"[{h}]" if ":" in h else h


def _check_hosts(section: str, key: str, v):
    """Host-like fields of particular sections, validated before saving."""
    bad = None
    if (section, key) == ("hue", "host"):
        if v and not valid_host(v):
            bad = v
    elif (section, key) == ("awair", "hosts"):
        bad = next((h for h in v if not valid_host(h)), None)
    elif (section, key) == ("dyson", "hosts"):
        for e in v:
            serial, _, host = e.partition("=")
            if not serial.strip() or not valid_host(host.strip()) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", serial.strip()):
                bad = e
                break
    if bad is not None:
        hint = "SERIAL=IP, e.g. TP7-US-ABC1234A=192.168.1.60" if section == "dyson" else "an IP address or host name"
        raise ValueError(f"{str(bad)[:80]!r} is not valid: use {hint}")


def _scalar_str(label: str, v, limit: int, truncate: bool) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list, tuple, set)):
        raise ValueError(f"{label}: must be text")
    v = str(v)
    if len(v) > limit:
        if not truncate:
            raise ValueError(f"{label}: too long (at most {limit} characters)")
        v = v[:limit]
    return v

_CTRL = re.compile(r"[\x00-\x1f\x7f]")


def _port(v) -> int:
    try:
        p = int(str(v).strip()) if v not in (None, "") else 3493
    except (TypeError, ValueError):
        raise ValueError(f"port {str(v)[:20]!r} is not a number") from None
    if not 1 <= p <= 65535:
        raise ValueError(f"port {p} is out of range (1-65535)")
    return p


def _server_key(o: dict) -> tuple:
    try:
        port = _port(o.get("port"))
    except ValueError:
        port = None
    return (str(o.get("host") or "").strip(), port, str(o.get("ups") or "").strip() or None)


def _clean_servers(label: str, v, current) -> list[dict]:
    """NUT servers: validated, and a kept ("********") password only stays with the exact same host, port and
    UPS it was entered for, so editing the host can't send the old password to a different server."""
    old = {_server_key(o): o for o in (current or []) if isinstance(o, dict)}
    cleaned = []
    for srv in (v if isinstance(v, list) else []):
        if not isinstance(srv, dict) or not srv.get("host"):
            continue
        srv = {k: srv.get(k) for k in ("name", "host", "port", "ups", "username", "password", "room")
               if srv.get(k) not in (None, "")}
        for k in ("name", "host", "ups", "username", "password", "room"):
            if k in srv:
                srv[k] = _scalar_str(f"{label} {k}", srv[k], MAX_SECRET_LEN if k == "password" else MAX_TEXT_LEN,
                                     truncate=k != "password")
                if _CTRL.search(srv[k]):          # a newline would inject extra NUT protocol commands
                    raise ValueError(f"{label}: {k} contains control characters")
                if k != "password":
                    srv[k] = srv[k].strip()
        if not valid_host(srv.get("host")):
            raise ValueError(f"{label}: {srv.get('host', '')[:80]!r} is not valid: use an IP address or host name")
        if "ups" in srv and not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", srv["ups"]):
            raise ValueError(f"{label}: UPS name {srv['ups'][:40]!r} may only contain letters, digits and _ . : -")
        srv["port"] = _port(srv.get("port"))
        if srv.get("password") == MASK:
            prev = old.get(_server_key(srv))
            if prev and prev.get("password"):
                srv["password"] = prev["password"]
            else:
                srv.pop("password")
        cleaned.append(srv)
    return cleaned


# Field types: text | password | number | bool | select | list (comma-separated) | servers
SCHEMA: list[dict] = [
    {"id": "yolink", "label": "YoLink", "icon": "sensors",
     "help": "YoLink app → Settings → Account → Advanced Settings → User Access Credentials → +. "
             "Copy the UAID and Secret Key.",
     "fields": [
         {"key": "uaid", "label": "UAID", "type": "text"},
         {"key": "secret_key", "label": "Secret Key", "type": "password"},
         {"key": "poll_seconds", "label": "Full refresh (seconds)", "type": "number", "default": 900},
     ]},
    {"id": "aqara", "label": "Aqara", "icon": "home_iot_device",
     "help": "developer.aqara.com → Console → Project Management → create a project, then copy App ID, "
             "App Key and Key ID. Save, then sign in below with your Aqara Home account.",
     "login": "aqara",
     "fields": [
         {"key": "region", "label": "Region", "type": "select", "default": "usa",
          "options": ["usa", "eu", "cn", "kr", "ru", "sg"]},
         {"key": "app_id", "label": "App ID", "type": "text"},
         {"key": "app_key", "label": "App Key", "type": "password"},
         {"key": "key_id", "label": "Key ID", "type": "text"},
         {"key": "poll_seconds", "label": "Poll every (seconds)", "type": "number", "default": 60},
     ]},
    {"id": "ecowitt", "label": "Ecowitt", "icon": "partly_cloudy_day",
     "help": "No account needed. In the Ecowitt / WS View Plus app → Customized: Protocol Ecowitt, "
             "Server = this server's IP, Port 1701 (HTTP; gateways can't use HTTPS), Path = the secret path shown below, "
             "Interval 60. Haven ignores gateways you haven't trusted: the secret path trusts it automatically, "
             "otherwise approve it below after its first report.",
     "push_info": True,
     "fields": [
         {"key": "passkeys", "label": "Always trust these gateway PASSKEYs (optional, comma-separated)",
          "type": "password"},
     ]},
    {"id": "xsense", "label": "X-Sense", "icon": "detector_smoke",
     "help": "Use a second X-Sense account that your devices are shared to. X-Sense allows one login "
             "per account, so your main account would log your phone out.",
     "fields": [
         {"key": "username", "label": "Email", "type": "text"},
         {"key": "password", "label": "Password", "type": "password"},
         {"key": "poll_seconds", "label": "Poll every (seconds)", "type": "number", "default": 120},
     ]},
    {"id": "ring", "label": "Ring", "icon": "videocam",
     "help": "Doorbells, cameras, floodlights and chimes. Turn on, save, then sign in below with your "
             "Ring account (you'll get a verification code). For Ring Alarm sensors, run ring-mqtt "
             "and enable MQTT.",
     "login": "ring",
     "fields": [
         {"key": "poll_seconds", "label": "Refresh battery and settings every (seconds)", "type": "number", "default": 120},
     ]},
    {"id": "hue", "label": "Philips Hue", "icon": "lightbulb",
     "help": "Lights, rooms and zones from your Hue Bridge, controlled locally. Choose Pair bridge: Haven "
             "looks for the bridge on your network (or type its IP), then asks you to press the round "
             "link button on top of the bridge.",
     "login": "hue",
     "fields": [
         {"key": "host", "label": "Bridge IP address", "type": "text"},
     ]},
    {"id": "nut", "label": "UPS (NUT)", "icon": "battery_charging_full",
     "help": "UniFi UPS: UniFi Network → the UPS → Settings → enable NUT Server (set a static IP; "
             "login credentials optional). Add every UPS with Add UPS (as many as you have). A NUT server that "
             "serves several UPSes (a NAS, a Pi running upsd) shows all of them unless you name one under UPS name. "
             "Haven only monitors: it shows charge, runtime, load and voltages, and never sends commands.",
     "fields": [
         {"key": "servers", "label": "UPS / NUT servers", "type": "servers"},
         {"key": "poll_seconds", "label": "Poll every (seconds)", "type": "number", "default": 5},
     ]},
    {"id": "mqtt", "label": "MQTT", "icon": "lan",
     "help": "Zigbee2MQTT, ESPHome, Tasmota, Shelly and ring-mqtt devices appear automatically via "
             "Home Assistant discovery. Custom topics are set in config.yaml.",
     "fields": [
         {"key": "host", "label": "Broker host", "type": "text", "default": "mosquitto"},
         {"key": "port", "label": "Port", "type": "number", "default": 1883},
         {"key": "username", "label": "Username", "type": "text"},
         {"key": "password", "label": "Password", "type": "password"},
         {"key": "discovery", "label": "Auto-discover devices", "type": "bool", "default": True},
         {"key": "discovery_prefix", "label": "Discovery prefix", "type": "text", "default": "homeassistant"},
     ]},
    {"id": "time", "label": "Date & time", "icon": "timer", "default_enabled": True,
     "help": "Haven checks its clock against NTP time servers and uses the corrected time for automations and "
             "schedules. A container can't change the computer's own clock, so if the offset shown here is large, "
             "fix the time on the host (Synology: Control Panel → Regional Options → Time → sync with an NTP server). "
             "The timezone decides when \"at 22:00\" happens; use an IANA name such as America/Phoenix.",
     "fields": [
         {"key": "timezone", "label": "Timezone", "type": "text", "default": os.getenv("TZ") or "UTC",
          "help": "IANA name like America/Phoenix, Europe/London or UTC."},
         {"key": "time_format", "label": "Clock", "type": "select", "default": "12h", "options": ["12h", "24h"]},
         {"key": "ntp_servers", "label": "NTP servers", "type": "list", "default": ["pool.ntp.org", "time.cloudflare.com"],
          "help": "Comma-separated. Your router or NAS works too, e.g. 192.168.1.1."},
         {"key": "sync_minutes", "label": "Check every (minutes)", "type": "number", "default": 60},
     ]},
    {"id": "history", "label": "History & metrics", "icon": "speed", "default_enabled": True,
     "help": "Keeps your sensor readings so charts can go back days, months or a year. "
             "SQLite (recommended) is built into Haven: it is a single file, data/history.db in your data folder, "
             "created by Haven itself. There is nothing to install, deploy or set up. "
             "Memory keeps only the last 24 hours and forgets them on restart. "
             "Prometheus is optional and separate: choose it only if you run a Prometheus server and want your "
             "history kept there (the \"metrics\" profile in docker-compose.yml starts one). "
             "Publish /metrics works with any of the three: it lets Prometheus, Grafana or any compatible tool "
             "collect the current readings.",
     "fields": [
         {"key": "backend", "label": "Store history in", "type": "select", "default": "sqlite",
          "options": ["sqlite", "memory", "prometheus"],
          "help": "SQLite needs nothing else: Haven writes data/history.db by itself."},
         {"key": "retention_days", "label": "Keep history for (days)", "type": "number", "default": 365,
          "help": "SQLite only. Older readings are deleted once a day. Applies right after you save."},
         {"key": "sample_seconds", "label": "Save a reading at most every (seconds)", "type": "number", "default": 60,
          "help": "Lower means more detail and a bigger file. Door, lock, leak and other on/off changes are always "
                  "saved immediately."},
         {"key": "prometheus_url", "label": "Prometheus URL", "type": "text", "default": "http://prometheus:9090",
          "help": "Only used when history is stored in Prometheus."},
         {"key": "metrics_enabled", "label": "Publish /metrics for Prometheus", "type": "bool", "default": True},
         {"key": "metrics_token", "label": "/metrics bearer token", "type": "password",
          "help": "Prometheus must send it (authorization: credentials: in prometheus.yml). Without a token, "
                  "/metrics only answers an admin who is signed in."},
     ]},
    {"id": "demo", "label": "Demo devices", "icon": "science",
     "help": "Sample devices for trying Haven. Turn off once your own devices show up.", "fields": []},
    # Not an integration: app/ha.py runs it (see SYNOLOGY.md, "High availability").
    {"id": "ha", "label": "High availability (beta)", "icon": "dns", "system": True,
     "help": "Run Haven on two NASes: one is active, the other waits on standby and takes over within about "
             "10 seconds if the active one stops answering. Both share a virtual IP address that always points at "
             "the active Haven: open the dashboard (and point Ecowitt gateways) at that address. Requirements: "
             "install Haven on both NASes with deploy/synology/docker-compose.ha.yml (host networking plus the "
             "NET_ADMIN and NET_RAW capabilities), both NASes on the same subnet, and a virtual IP that no device "
             "uses and that is outside your router's DHCP range. Set up the primary first, then the standby with the "
             "same shared secret and virtual IP. The standby stops its integrations and automations, so devices are "
             "only polled and controlled once, and copies its settings from the active Haven. Each NAS keeps its "
             "own history.",
     "fields": [
         {"key": "role", "label": "This Haven is the", "type": "select", "default": "primary",
          "options": ["primary", "standby"],
          "help": "primary on one NAS, standby on the other."},
         {"key": "peer", "label": "Other Haven's address", "type": "text",
          "help": "The other NAS's own IP (not the virtual IP), e.g. 192.168.1.21 or 192.168.1.21:1701. "
                  "Use https://192.168.1.21:1702 to talk over HTTPS."},
         {"key": "secret", "label": "Shared secret", "type": "password",
          "help": "At least 16 characters, exactly the same on both Havens. It signs and encrypts what the two "
                  "send each other and is never sent itself."},
         {"key": "vip", "label": "Virtual IP address", "type": "text",
          "help": "An unused IPv4 address on the same subnet as both NASes and outside the DHCP range, "
                  "e.g. 192.168.1.50."},
         {"key": "prefix", "label": "Prefix length", "type": "number", "default": 24,
          "help": "24 for a 255.255.255.0 network."},
         {"key": "preempt", "label": "Primary takes over again when it's back", "type": "bool", "default": True},
         {"key": "sync", "label": "Copy settings from the active Haven", "type": "bool", "default": True,
          "help": "Accounts, layout, devices and automations. The standby's own high-availability settings and "
                  "certificates are never copied. Change settings on the active Haven (the virtual IP)."},
         {"key": "priority", "label": "Priority (1-254, higher wins)", "type": "number", "advanced": True,
          "help": "Empty = 200 for primary, 100 for standby."},
         {"key": "interface", "label": "Network interface", "type": "text", "advanced": True,
          "help": "Empty = automatic: the interface on the virtual IP's subnet (e.g. eth0, ovs_eth0, bond0)."},
         {"key": "heartbeat_seconds", "label": "Heartbeat every (seconds)", "type": "number", "default": 2,
          "advanced": True},
         {"key": "failover_after", "label": "Take over after this many missed heartbeats", "type": "number",
          "default": 5, "advanced": True},
         {"key": "check_address", "label": "Isolation check address", "type": "text", "advanced": True,
          "help": "Empty = your router. When the other Haven is silent, this Haven only takes over if it can "
                  "still reach this address (host or host:port), so a NAS cut off from the network doesn't grab "
                  "the virtual IP."},
         {"key": "verify_tls", "label": "Verify the other Haven's HTTPS certificate", "type": "bool",
          "default": False, "advanced": True,
          "help": "Only with https:// and a real certificate. Leave off for Haven's self-signed certificate: "
                  "heartbeats and settings are signed and encrypted with the shared secret either way."},
     ]},
]
def _add_plugin_sections() -> None:
    """Integrations that register themselves (see app/adapters/__init__.py) bring their own section."""
    from .adapters import PLUGIN_SETTINGS
    pos = next((i for i, s in enumerate(SCHEMA) if s["id"] in ("mqtt", "history", "demo")), len(SCHEMA))
    for sec in sorted(PLUGIN_SETTINGS, key=lambda x: x["label"].lower()):
        if all(s["id"] != sec["id"] for s in SCHEMA):
            SCHEMA.insert(pos, sec)
            pos += 1


_add_plugin_sections()
from . import edition as _edition  # noqa: E402
from .adapters import ADAPTERS as _ADAPTERS  # noqa: E402
_edition.trim_settings(SCHEMA, _ADAPTERS)     # Home Assistant edition: only the sections that apply
SCHEMA_BY_ID = {s["id"]: s for s in SCHEMA}

# A kept ("********") secret only stays if the address it was meant for didn't change; otherwise
# a changed host would receive the old password. section -> (address fields, secret fields)
SECRET_BOUND_TO = {
    "mqtt": (["host"], ["password"]),
    "history": (["prometheus_url"], ["metrics_token"]),
    "airquality": (["provider"], ["airnow_api_key"]),
    "aqara": (["region"], ["app_key"]),
    "dyson": (["region"], ["password"]),
    "homeassistant": (["url"], ["access_token"]),
    "tapo": (["hosts"], []),
    # protocol too: switching SFTP -> plain FTP must not send the stored password unencrypted
    "backup": (["host", "port", "username", "protocol"], ["password", "private_key"]),
}


def _get(d: dict, dotted: str, default=None):
    for part in dotted.split("."):
        if not isinstance(d, dict) or part not in d:
            return default
        d = d[part]
    return d


def _set(d: dict, dotted: str, value) -> None:
    parts = dotted.split(".")
    for part in parts[:-1]:
        d = d.setdefault(part, {})
    d[parts[-1]] = value


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


def load_saved() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except Exception:  # noqa: BLE001
        return {}


def effective_config() -> dict:
    """config.yaml with Settings-page values layered on top, then field defaults for anything
    still missing (so e.g. the NUT server password really is "secret" when the UI says so,
    and a cleared number field falls back to its default instead of breaking the adapter)."""
    cfg = _merge(load_config(), load_saved())
    for s in SCHEMA:
        sec = cfg.get(s["id"])
        if not isinstance(sec, dict):
            continue
        for f in s["fields"]:
            if "default" in f and _get(sec, f["key"]) is None:
                _set(sec, f["key"], copy.deepcopy(f["default"]))
    return cfg


def _del(d: dict, dotted: str) -> None:
    parts = dotted.split(".")
    for part in parts[:-1]:
        d = d.get(part)
        if not isinstance(d, dict):
            return
    d.pop(parts[-1], None)


def public_view(cfg: dict, statuses: dict[str, str]) -> list[dict]:
    out = []
    for s in SCHEMA:
        sec = cfg.get(s["id"]) or {}
        values: dict[str, Any] = {}
        for f in s["fields"]:
            v = _get(sec, f["key"], f.get("default"))
            if f["type"] == "password":
                values[f["key"]] = MASK if v else ""
            elif f["type"] == "servers":
                values[f["key"]] = [{**srv, "password": MASK if srv.get("password") else ""} for srv in (v or [])]
            else:
                values[f["key"]] = v
        out.append({**{k: s[k] for k in s if k != "fields"}, "fields": s["fields"], "values": values,
                    "enabled": (sec.get("enabled", True) if cfg.get(s["id"]) is not None else bool(s.get("default_enabled"))),
                    "status": statuses.get(s["id"])})
    return out


def save_section(section: str, enabled: bool, values: dict[str, Any]) -> dict:
    schema = SCHEMA_BY_ID[section]
    saved = load_saved()
    current = effective_config().get(section) or {}
    sec = saved.setdefault(section, {})
    sec["enabled"] = bool(enabled)
    addr_keys, secret_keys = SECRET_BOUND_TO.get(section, ([], []))
    moved = any(k in values and values[k] not in (None, "") and str(values[k]) != str(_get(current, k) or "")
                for k in addr_keys if _get(current, k) not in (None, ""))
    for f in schema["fields"]:
        if f["key"] not in values:
            continue
        v = values[f["key"]]
        if f["type"] == "password":
            if v is None or v == MASK:
                if moved and f["key"] in secret_keys:
                    _set(sec, f["key"], "")   # address changed: don't send the old secret to the new one
                continue                      # unchanged
            v = _scalar_str(f["label"], v, MAX_SECRET_LEN, truncate=False)
        elif f["type"] == "number":
            if v in ("", None):
                _del(sec, f["key"])           # fall back to the default
                continue
            try:
                v = float(v) if "." in str(v) or "e" in str(v).lower() else int(v)
            except (TypeError, ValueError, OverflowError):
                raise ValueError(f"{f['label']}: not a number")
            if not math.isfinite(v) or abs(v) > 1e12:
                raise ValueError(f"{f['label']}: not a number")
        elif f["type"] == "select":
            if v in ("", None):
                _del(sec, f["key"])
                continue
            if v not in f.get("options", []):
                raise ValueError(f"{f['label']}: choose one of {', '.join(map(str, f.get('options', [])))}")
        elif f["type"] in ("text",):
            v = _scalar_str(f["label"], v, MAX_TEXT_LEN, truncate=True)
            if (section, f["key"]) == ("hue", "host"):
                v = v.strip()
        elif f["type"] == "bool":
            v = bool(v)
        elif f["type"] == "toggles":        # switches: the ids that are on ("mode": "on") or off ("mode": "off")
            if not isinstance(v, (list, tuple)):
                raise ValueError(f"{f['label']}: must be a list")
            v = list(dict.fromkeys(_scalar_str(f["label"], x, 80, truncate=True).strip() for x in v[:300]))
            v = [x for x in v if x]
        elif f["type"] == "list":
            if v is not None and not isinstance(v, (str, list, tuple)):
                raise ValueError(f"{f['label']}: must be a comma-separated list")
            items = v.split(",") if isinstance(v, str) else list(v or [])
            v = [_scalar_str(f["label"], x, MAX_TEXT_LEN, truncate=True).strip() for x in items[:200]]
            v = [x for x in v if x]
        elif f["type"] == "servers":
            v = _clean_servers(f["label"], v, current.get("servers"))
        elif f["type"] == "hostlist":       # one address per row in the page
            items = re.split(r"[\s,;]+", v) if isinstance(v, str) else list(v or [])
            out = []
            for x in items[:64]:
                h = _scalar_str(f["label"], x, 253, truncate=False).strip()
                if not h:
                    continue
                if not valid_host(h):
                    raise ValueError(f"{h[:80]!r} is not an IP address or host name")
                if h not in out:
                    out.append(h)
            v = out
        _check_hosts(section, f["key"], v)
        _set(sec, f["key"], v)
    if section == "ha":
        from .ha import validate_section   # peer address, secret length, virtual IP, ranges
        validate_section(_merge(current, sec))
    write_private(SETTINGS_FILE, json.dumps(saved, indent=2))
    return effective_config()
