"""Constants of the Haven integration (HACS edition)."""
from __future__ import annotations

DOMAIN = "haven"
TITLE = "Haven"

PANEL_URL_PATH = "haven"                 # http://homeassistant.local:8123/haven
PANEL_ELEMENT = "haven-panel"
PANEL_ICON = "mdi:home-circle-outline"

API_PREFIX = "/api/haven"                # Haven's /api/<x> is served at /api/haven/<x> (HA sign-in required)
WS_URL = "/api/haven/websocket"          # Haven's /ws (signs in with the first message, like HA's own)
STATIC_URL = "/haven_static"             # app/static (the dashboard's files; no secrets in there)
PANEL_FILES_URL = "/haven_panel"         # frontend/: panel.js, the dashboard page, the shim

DATA_FOLDER = "haven"                    # <config>/haven: settings, layout, automations, history.db
