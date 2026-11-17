"""Which Haven this is: "og" (the Docker app, the default) or "hacs" (the Home Assistant integration).

The HACS edition (repository ryanbyte1701/haven-hacs, generated from this one by tools/hacs/build.py) runs
this same core inside Home Assistant. Its wrapper (custom_components/haven/__init__.py) sets HAVEN_EDITION=hacs
before it imports anything from the core; nothing else in the environment changes it. See docs/hacs.md.

In the HACS edition:
- devices come only from Home Assistant itself (app/adapters/hass_local.py); Haven's own integrations
  (YoLink, Hue, MQTT, ...) are not even shipped;
- sign-in is Home Assistant's: HA admins are Haven admins, everyone else is a Regular user;
- the Settings page lists only what applies (no accounts, date & time, backups, high availability, demo);
- the Ecowitt push endpoint, /metrics and the high-availability API are not reachable.
"""
from __future__ import annotations

import os

EDITION = "hacs" if os.getenv("HAVEN_EDITION", "").strip().lower() == "hacs" else "og"
HACS = EDITION == "hacs"

# Adapter modules (app/adapters/<name>.py) per edition. The HACS edition is default-deny: only these load
# (and tools/hacs/manifest.py decides which files are shipped at all).
HACS_ADAPTER_MODULES = frozenset({"hass_local"})
# Modules that only work in the other edition: hass_local needs a running Home Assistant (`hass`).
OG_SKIP_ADAPTER_MODULES = frozenset({"hass_local"})

# Settings page sections that are not integrations but still apply in the HACS edition
# (Home page & menu and Appearance are drawn by the browser and always shown).
HACS_CORE_SECTIONS = ("history",)
# Fields hidden in the HACS edition: /metrics isn't served there.
HACS_HIDDEN_FIELDS = {"history": {"metrics_enabled", "metrics_token"}}

# API paths the HACS bridge never forwards (prefix match on whole path segments).
HACS_BLOCKED_PATHS = (
    "/api/auth",            # Haven's own sign-in: Home Assistant signs people in
    "/api/users",           # Haven's own accounts
    "/api/me/password",
    "/api/ha",              # high availability (two Docker Havens)
    "/api/ecowitt",         # Ecowitt push gateways
    "/api/settings/aqara", "/api/settings/ring", "/api/settings/hue",    # sign-ins of integrations not shipped
    "/api/aqara", "/api/ring",
    "/metrics",
    "/data",
    "/ecowitt",
)


def adapter_allowed(module: str) -> bool:
    """May app/adapters/<module>.py register itself in this edition?"""
    if HACS:
        return module in HACS_ADAPTER_MODULES
    return module not in OG_SKIP_ADAPTER_MODULES


def trim_settings(schema: list[dict], adapters) -> None:
    """HACS edition: keep only the Settings sections that apply (in place). No-op in the Docker edition."""
    if not HACS:
        return
    keep = set(adapters) | set(HACS_CORE_SECTIONS)
    schema[:] = [s for s in schema if s["id"] in keep]
    for s in schema:
        hidden = HACS_HIDDEN_FIELDS.get(s["id"])
        if hidden:
            s["fields"] = [f for f in s["fields"] if f["key"] not in hidden]
        if s["id"] == "history":
            s["help"] = ("Keeps your sensor readings so charts can go back days, months or a year. SQLite "
                         "(recommended) is a single file, haven/history.db in Home Assistant's configuration folder, "
                         "so Home Assistant's backups include it. Memory keeps only the last 24 hours. Prometheus is "
                         "optional: choose it only if you run a Prometheus server.")


def path_blocked(path: str) -> bool:
    """HACS bridge: is this Haven path one the HACS edition doesn't serve?"""
    return any(path == p or path.startswith(p + "/") for p in HACS_BLOCKED_PATHS)
