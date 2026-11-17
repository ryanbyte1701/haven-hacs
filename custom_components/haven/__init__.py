"""Haven for Home Assistant: Haven's dashboard in Home Assistant's sidebar, with every device from Home Assistant.

GENERATED into ryanbyte1701/haven-hacs from ryanbyte1701/haven (tools/hacs/). Edit it there, not here.

How it fits together (docs/hacs.md in the source repository):
- core/ is Haven itself (the same code as the Docker edition), started with HAVEN_EDITION=hacs;
- its FastAPI app runs in-process behind Home Assistant's own web server (bridge.py, views.py): /api/haven/...;
- devices come from Home Assistant's registries and states (core/adapters/hass_local.py), controls are service calls;
- sign-in is Home Assistant's (auth_bridge.py): HA admins are Haven admins, other users are Regular users;
- the "Haven" sidebar panel (frontend/panel.js) shows the dashboard and passes the user's token to it.
Settings, layout, automations and history are kept in <config>/haven/.
"""
from __future__ import annotations

import importlib
import logging
import os
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DATA_FOLDER, DOMAIN, PANEL_ELEMENT, PANEL_FILES_URL, PANEL_ICON, PANEL_URL_PATH, STATIC_URL, TITLE

_LOGGER = logging.getLogger(__name__)
HERE = Path(__file__).parent
CORE = f"{__name__}.core"


def _write_base_config(folder: Path, hass: HomeAssistant) -> Path:
    """The settings Haven starts from (core/config.py reads them like the Docker edition's config.yaml);
    what you change in Haven → Settings is saved on top, in settings.json."""
    folder.mkdir(parents=True, exist_ok=True)
    us = getattr(getattr(hass.config, "units", None), "temperature_unit", "°C") == "°F"
    tz = str(hass.config.time_zone or "UTC")
    path = folder / "base_config.yaml"
    path.write_text(
        "# Written by the Haven integration at every start: don't edit (use Haven → Settings instead).\n"
        "hass:\n  enabled: true\n"
        "history:\n  enabled: true\n  backend: sqlite\n  sample_seconds: 60\n  retention_days: 365\n"
        "  metrics_enabled: false\n"
        f"time:\n  enabled: false\n  timezone: {tz!r}\n  time_format: {'12h' if us else '24h'}\n"
    )
    return path


def _prepare_environment(folder: Path, base_config: Path) -> None:
    """Haven's core reads these when it is first imported (core/config.py, core/edition.py)."""
    os.environ["HAVEN_EDITION"] = "hacs"
    os.environ["HAVEN_DATA"] = str(folder)
    os.environ["HAVEN_CONF_DIR"] = str(folder)
    os.environ["HAVEN_CONFIG"] = str(base_config)


def _import_core():
    main = importlib.import_module(f"{CORE}.main")
    importlib.import_module(f"{CORE}.adapters.hass_local")
    return main


class HavenRuntime:
    """Haven's core, running inside this Home Assistant."""

    def __init__(self, hass: HomeAssistant, version: str) -> None:
        self.hass = hass
        self.version = version
        self.bridge = None
        self.main = None

    async def async_start(self) -> None:
        hass = self.hass
        folder = Path(hass.config.path(DATA_FOLDER))
        base = await hass.async_add_executor_job(_write_base_config, folder, hass)
        _prepare_environment(folder, base)
        if f"{CORE}.main" not in __import__("sys").modules:
            _LOGGER.info("Loading Haven %s (settings and history in %s)", self.version, folder)
        self.main = await hass.async_add_import_executor_job(_import_core)
        hass_local = importlib.import_module(f"{CORE}.adapters.hass_local")
        auth = importlib.import_module(f"{CORE}.auth")
        edition = importlib.import_module(f"{CORE}.edition")
        if not edition.HACS:
            raise RuntimeError("Haven's core was loaded before the Home Assistant edition was selected")
        from .auth_bridge import HassAuthStore
        from .bridge import AsgiBridge

        hass_local.set_hass(hass)
        store = HassAuthStore(hass)
        auth.store = store
        self.bridge = AsgiBridge(self.main.app, blocked=edition.path_blocked, ws_token=store.ws_ticket,
                                 on_request=store.prepare_request)
        await self.bridge.startup()             # Haven's own thread and event loop (see bridge.py)

    async def async_stop(self) -> None:
        if self.bridge is not None:
            await self.bridge.shutdown()        # afterwards it answers 503 until the entry is loaded again


async def _register_http(hass: HomeAssistant, runtime: HavenRuntime) -> None:
    """Views and static paths can't be removed from Home Assistant's web server, so they are added once per
    Home Assistant start and look up the current runtime (a reloaded entry gets a new one)."""
    holder = hass.data.setdefault(DOMAIN, {})
    holder["runtime"] = runtime
    if holder.get("http"):
        return
    from homeassistant.components.http import StaticPathConfig

    from .views import HavenApiView, HavenWebSocketView

    class _Current:
        @property
        def bridge(self):
            return hass.data[DOMAIN]["runtime"].bridge

    current = _Current()
    hass.http.register_view(HavenWebSocketView(current))
    hass.http.register_view(HavenApiView(current))
    await hass.http.async_register_static_paths([
        StaticPathConfig(STATIC_URL, str(HERE / "core" / "static"), False),
        StaticPathConfig(PANEL_FILES_URL, str(HERE / "frontend"), False),
    ])
    holder["http"] = True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    integration = await async_get_integration(hass, DOMAIN)
    version = str(integration.version or "dev")
    runtime = HavenRuntime(hass, version)
    await runtime.async_start()
    entry.runtime_data = runtime

    async def _stop(_event) -> None:              # save history and settings when Home Assistant stops
        await runtime.async_stop()
    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _stop))
    await _register_http(hass, runtime)

    from homeassistant.components import panel_custom

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{PANEL_FILES_URL}/panel.js?v={version}",
        embed_iframe=False,
        require_admin=False,
        config={"index": f"{PANEL_FILES_URL}/index.html?v={version}", "version": version},
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    from homeassistant.components import frontend

    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    await entry.runtime_data.async_stop()
    return True
