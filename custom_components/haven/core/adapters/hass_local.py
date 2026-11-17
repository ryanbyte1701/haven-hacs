"""Home Assistant, in-process: the device source of the HACS edition (Haven running inside Home Assistant).

The HACS edition (app/edition.py, docs/hacs.md) runs Haven's core inside Home Assistant, so instead of
connecting to HA's WebSocket API with a token (app/adapters/homeassistant.py) it reads Home Assistant's own
objects directly:

- the area, device and entity registries and `hass.states`;
- EVENT_STATE_CHANGED for live updates, and the registry-updated events for new, renamed, moved or removed
  devices (re-read after a short pause, so a burst of changes is one reload);
- controls go to `hass.services.async_call`.

Haven may run its own event loop in its own thread (the HACS wrapper does that, so Haven's file and database
work never holds up Home Assistant): everything that touches `hass` is then run in Home Assistant's loop
(hass.loop) and the events are handed back to Haven's loop.

Everything else is the WebSocket adapter's code, reused as is: which entities are imported (hidden, disabled
and configuration/diagnostic entities are skipped, battery level is kept), how they map to Haven capabilities
(map_entity), how entities group into one card per HA device in its area, and which service a control calls.
This class only answers the WebSocket messages that code sends (`_send`) from the local objects. Unlike the
Docker edition nothing is skipped as "native": in this edition every device comes from Home Assistant.

Loaded only in the HACS edition (app/edition.py); the wrapper hands it `hass` via set_hass() before start.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from enum import Enum
from typing import Any

from .homeassistant import DOMAINS, HomeAssistantAdapter

log = logging.getLogger("hass_local")

_HASS: Any = None          # set by the HACS wrapper (custom_components/haven/__init__.py)

# Home Assistant event names (homeassistant.const / helpers.*_registry); strings so this module imports
# without Home Assistant installed (tests, the Docker edition's test run).
EVENT_STATE_CHANGED = "state_changed"
REGISTRY_EVENTS = ("entity_registry_updated", "device_registry_updated", "area_registry_updated")
RELOAD_DELAY = 2.0         # seconds: registry events come in bursts (an integration adding 30 entities)


def _callback(func):
    """Home Assistant's @callback (homeassistant.core.callback) without importing it: the bus then runs the
    listener right in the event loop instead of in a worker thread."""
    func._hass_callback = True
    return func


def set_hass(hass: Any) -> None:
    global _HASS
    _HASS = hass


def _plain(v: Any) -> Any:
    """Registry values are StrEnums, sets and tuples: make them what the WebSocket API would have sent."""
    if isinstance(v, Enum):
        return v.value
    if isinstance(v, (set, frozenset, tuple, list)):
        return [_plain(x) for x in v]
    return v


class _LocalLink:
    """Stands in for the WebSocket: HomeAssistantAdapter checks `self.ws` before a command and closes it on stop."""

    async def close(self) -> None:
        pass


class HassLocalAdapter(HomeAssistantAdapter):
    source = "hass"

    def __init__(self, hub, cfg):
        super().__init__(hub, cfg)
        self.include_native = True          # everything in Home Assistant is imported in this edition
        self.hass = _HASS
        self._unsubs: list = []
        self._reload: asyncio.TimerHandle | None = None
        self._reload_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ---------------- Home Assistant's loop / Haven's loop ----------------
    def _hass_loop(self):
        loop = getattr(self.hass, "loop", None)
        return None if loop is None or loop is self._loop else loop

    async def _in_hass(self, fn, *args):
        """Run fn(*args) in Home Assistant's event loop (directly when Haven shares it)."""
        hloop = self._hass_loop()
        if hloop is None:
            return fn(*args)
        fut: concurrent.futures.Future = concurrent.futures.Future()

        def run():
            try:
                fut.set_result(fn(*args))
            except BaseException as e:  # noqa: BLE001 - handed to the caller
                fut.set_exception(e)
        hloop.call_soon_threadsafe(run)
        return await asyncio.wrap_future(fut)

    async def _in_hass_await(self, coro_fn):
        hloop = self._hass_loop()
        if hloop is None:
            return await coro_fn()
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro_fn(), hloop))

    def _to_haven(self, fn, *args) -> None:
        """From a Home Assistant event listener: run fn(*args) in Haven's loop."""
        if self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(fn, *args)

    async def start(self):
        if self.hass is None:
            self.status = "error: Home Assistant isn't available (this integration only runs inside Home Assistant)"
            return
        self._loop = asyncio.get_running_loop()
        self.ws = _LocalLink()
        await self._load()

        def subscribe():
            bus = self.hass.bus
            return [bus.async_listen(EVENT_STATE_CHANGED, self._on_state)] + \
                   [bus.async_listen(ev, self._on_registry) for ev in REGISTRY_EVENTS]
        self._unsubs = await self._in_hass(subscribe)

    async def stop(self):
        unsubs, self._unsubs = self._unsubs, []

        def unsubscribe():
            for unsub in unsubs:
                try:
                    unsub()
                except Exception:  # noqa: BLE001
                    pass
        if unsubs:
            try:
                await self._in_hass(unsubscribe)
            except RuntimeError:             # Home Assistant's loop already closed (shutting down)
                pass
        if self._reload is not None:
            self._reload.cancel()
            self._reload = None
        if self._reload_task is not None:
            self._reload_task.cancel()
            await asyncio.gather(self._reload_task, return_exceptions=True)
            self._reload_task = None
        await super().stop()
        self.ws = None

    # ---------------- events: the listeners run in Home Assistant's loop, the work in Haven's ----------------
    @_callback
    def _on_state(self, event) -> None:
        data = event.data
        eid = data.get("entity_id")
        ns = data.get("new_state")
        new = None if ns is None else (ns.state, dict(ns.attributes))
        self._to_haven(self._state_changed, eid, new, data.get("old_state") is None)

    @_callback
    def _on_registry(self, event) -> None:
        self._to_haven(self._schedule_reload)

    def _state_changed(self, eid: str, new: tuple | None, created: bool) -> None:
        if eid in self.entity_dev:
            if new is None:                     # entity removed
                self._schedule_reload()
                return
            self._apply(eid, {"state": new[0], "attributes": new[1]})
        elif new is not None and created and eid and eid.split(".", 1)[0] in self.domains:
            self._schedule_reload()             # a new entity Haven may want

    def _schedule_reload(self) -> None:
        if self._reload is not None:
            self._reload.cancel()
        loop = asyncio.get_running_loop()
        self._reload = loop.call_later(RELOAD_DELAY, self._start_reload)

    def _start_reload(self) -> None:
        self._reload = None
        if self._reload_task is None or self._reload_task.done():
            self._reload_task = asyncio.ensure_future(self._reload_now())

    async def _reload_now(self) -> None:
        try:
            await self._load()
        except Exception as e:  # noqa: BLE001
            self.log.warning("re-reading Home Assistant's devices failed: %s", e)

    async def action(self, name: str) -> str:
        if name != "refresh":
            raise ValueError(name)
        await self._load()
        return self.summary()

    # ---------------- the WebSocket messages HomeAssistantAdapter sends, answered locally ----------------
    async def _send(self, msg: dict, timeout: float = 30) -> Any:
        kind = msg.get("type")
        if kind == "subscribe_events":
            return None                         # start() listens on the bus itself
        if kind == "call_service":
            hass = self.hass
            return await self._in_hass_await(lambda: hass.services.async_call(
                msg["domain"], msg["service"], dict(msg.get("service_data") or {}), blocking=True,
                target=msg.get("target")))
        return await self._in_hass(self._read, kind)

    def _read(self, kind: str) -> Any:
        """Answer a WebSocket API read from Home Assistant's own objects (in Home Assistant's loop)."""
        hass = self.hass
        if kind == "config/area_registry/list":
            from homeassistant.helpers import area_registry as ar
            return [{"area_id": a.id, "name": a.name} for a in ar.async_get(hass).async_list_areas()]
        if kind == "config/device_registry/list":
            from homeassistant.helpers import device_registry as dr
            reg = dr.async_get(hass)
            # iterating .devices gives the entries (Home Assistant 2026.10+; before that it gave their ids)
            entries = [reg.devices[d] if isinstance(d, str) else d for d in list(reg.devices)]
            return [{"id": d.id, "name": d.name, "name_by_user": d.name_by_user, "manufacturer": d.manufacturer,
                     "model": d.model, "area_id": d.area_id, "identifiers": _plain(d.identifiers),
                     "disabled_by": _plain(d.disabled_by)} for d in entries]
        if kind == "config/entity_registry/list":
            from homeassistant.helpers import entity_registry as er
            return [{"entity_id": e.entity_id, "device_id": e.device_id, "area_id": e.area_id,
                     "disabled_by": _plain(e.disabled_by), "hidden_by": _plain(e.hidden_by),
                     "entity_category": _plain(e.entity_category), "platform": e.platform,
                     "config_entry_id": e.config_entry_id}
                    for e in list(er.async_get(hass).entities.values())]
        if kind == "get_states":
            return [{"entity_id": s.entity_id, "state": s.state, "attributes": dict(s.attributes)}
                    for s in hass.states.async_all(DOMAINS)]
        if kind == "config_entries/get":
            return [{"entry_id": e.entry_id, "domain": e.domain} for e in hass.config_entries.async_entries()]
        raise RuntimeError(f"hass_local: unsupported request {kind!r}")


ADAPTER = HassLocalAdapter
SETTINGS = {
    "id": "hass", "label": "Home Assistant", "icon": "home", "default_enabled": True,
    "help": "Haven shows the devices you have in Home Assistant, in their Home Assistant areas, and controls them "
            "through Home Assistant. New, renamed and moved devices show up by themselves. Hidden, disabled, "
            "configuration and diagnostic entities are left out (battery levels are kept). Use the filters below "
            "to show less.",
    "fields": [
        {"key": "areas", "label": "Only these areas (optional, comma-separated)", "type": "list"},
        {"key": "exclude", "label": "Skip entities (optional, e.g. sensor.*_rssi, light.hallway)", "type": "list"},
        {"key": "domains", "label": "Entity types to import", "type": "list", "default": list(DOMAINS)},
    ],
    "actions": [{"id": "refresh", "label": "Refresh now", "icon": "sync"}],
}
