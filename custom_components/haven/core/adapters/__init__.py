"""Adapter registry.

Built-in adapters are listed below. New integrations can live in their own module in this
package and register themselves by defining two module-level names (no edits here needed):

    ADAPTER = MyAdapter                 # the Adapter subclass; its `source` is the config/settings id
    SETTINGS = {"id": ..., "label": ..., "icon": ..., "help": ..., "fields": [...]}   # Settings page section

Modules are discovered automatically at import time.
"""
import importlib
import logging
import pkgutil

from .. import edition

if edition.HACS:      # Home Assistant edition: devices come only from Home Assistant (app/edition.py)
    ADAPTERS: dict = {}
else:
    from .aqara import AqaraAdapter
    from .demo import DemoAdapter
    from .ecowitt import EcowittAdapter
    from .hue import HueAdapter
    from .mqtt import MqttAdapter
    from .nut import NutAdapter
    from .ring import RingAdapter
    from .xsense import XSenseAdapter
    from .yolink import YoLinkAdapter

    ADAPTERS = {
        "yolink": YoLinkAdapter,
        "aqara": AqaraAdapter,
        "ecowitt": EcowittAdapter,
        "xsense": XSenseAdapter,
        "mqtt": MqttAdapter,
        "nut": NutAdapter,
        "hue": HueAdapter,
        "ring": RingAdapter,
    }
PLUGIN_SETTINGS: list[dict] = []

_BUILTIN = {"aqara", "demo", "ecowitt", "hue", "mqtt", "nut", "ring", "xsense", "yolink", "base"}
for _m in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
    if _m.name in _BUILTIN or _m.name.startswith("_") or not edition.adapter_allowed(_m.name):
        continue
    try:
        _mod = importlib.import_module(f"{__name__}.{_m.name}")
    except Exception as _e:  # noqa: BLE001 - a broken plugin must not take the app down
        logging.getLogger("adapters").error("could not load integration %s: %s", _m.name, _e)
        continue
    _cls = getattr(_mod, "ADAPTER", None)
    if _cls is not None:
        ADAPTERS[_cls.source] = _cls
        if getattr(_mod, "SETTINGS", None):
            PLUGIN_SETTINGS.append(_mod.SETTINGS)

if not edition.HACS:
    ADAPTERS["demo"] = DemoAdapter      # keep demo last
