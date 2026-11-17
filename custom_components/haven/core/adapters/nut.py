"""NUT (Network UPS Tools) monitoring.

Polls one or more NUT servers, e.g. the one built into UniFi UPS Tower / UPS-2U
(UniFi Network > the UPS > Settings > NUT Server), or APC/CyberPower via a NAS, and shows each UPS's
status, charge, runtime, load and voltages. Haven only reads: it never sends commands to a UPS.
"""
from __future__ import annotations

import asyncio
import re
import shlex
import time
from typing import Any

from ..models import Device, cap
from .base import Adapter

MAX_LIST_ROWS = 2000          # a NUT server answering with endless LIST lines must not exhaust memory
REPUBLISH_SECONDS = 60        # unchanged readings are still pushed to browsers / history this often
_CTRL = re.compile(r"[\x00-\x1f\x7f]")
_UPS_NAME = re.compile(r"[A-Za-z0-9_.:-]{1,64}")


def nut_arg(value: str, what: str, spaces: bool = True) -> str:
    """One argument of a NUT protocol command. Control characters (a newline would start a new command) are
    refused; with `spaces`, values containing spaces, quotes or backslashes are quoted the way upsd parses them."""
    value = str(value)
    if _CTRL.search(value):
        raise ValueError(f"NUT {what} contains control characters")
    if not spaces:
        if not _UPS_NAME.fullmatch(value):
            raise ValueError(f"NUT {what} {value[:40]!r} is not a valid name")
        return value
    if value == "" or re.search(r'[\s"\\]', value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


class NutClient:
    def __init__(self, host: str, port: int = 3493, username: str | None = None,
                 password: str | None = None, timeout: float = 5):
        self.host, self.port, self.username, self.password, self.timeout = host, port, username, password, timeout
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None

    async def connect(self):
        self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), self.timeout)
        if self.username:
            await self._cmd(f"USERNAME {nut_arg(self.username, 'username')}")
            await self._cmd(f"PASSWORD {nut_arg(self.password or '', 'password')}")

    async def close(self):
        if self.writer:
            try:
                self.writer.write(b"LOGOUT\n")
                await self.writer.drain()
                self.writer.close()
            except Exception:  # noqa: BLE001
                pass
        self.reader = self.writer = None

    async def _line(self) -> str:
        line = await asyncio.wait_for(self.reader.readline(), self.timeout)
        if not line:
            raise ConnectionError("NUT server closed the connection")
        return line.decode(errors="replace").rstrip("\r\n")

    async def _cmd(self, cmd: str) -> str:
        self.writer.write(cmd.encode() + b"\n")
        await self.writer.drain()
        resp = await self._line()
        if resp.startswith("ERR"):
            raise RuntimeError(f"{cmd.split()[0]}: {resp}")
        return resp

    async def _list(self, what: str) -> list[list[str]]:
        self.writer.write(f"LIST {what}\n".encode())
        await self.writer.drain()
        first = await self._line()
        if first.startswith("ERR"):
            raise RuntimeError(f"LIST {what}: {first}")
        rows = []
        while True:
            line = await self._line()
            if line.startswith("END LIST"):
                return rows
            if len(rows) >= MAX_LIST_ROWS:
                raise RuntimeError(f"LIST {what}: more than {MAX_LIST_ROWS} lines")
            try:
                rows.append(shlex.split(line))
            except ValueError:          # unbalanced quotes: skip the line
                continue

    async def list_ups(self) -> dict[str, str]:
        return {r[1]: (r[2] if len(r) > 2 else r[1]) for r in await self._list("UPS")
                if len(r) >= 2 and _UPS_NAME.fullmatch(r[1])}

    async def list_vars(self, ups: str) -> dict[str, str]:
        return {r[2]: r[3] for r in await self._list(f"VAR {nut_arg(ups, 'UPS name', spaces=False)}") if len(r) >= 4}


def parse_status(vars_: dict[str, str]) -> dict[str, Any]:
    """Turn NUT variables into capability values."""
    flags = set(vars_.get("ups.status", "").split())
    out: dict[str, Any] = {}
    if "OB" in flags:
        out["ups_status"] = "low_battery" if "LB" in flags else "on_battery"
    elif "OL" in flags:
        out["ups_status"] = "online"
    elif "OFF" in flags:
        out["ups_status"] = "offline"
    out["charging"] = "CHRG" in flags
    out["replace_battery"] = "RB" in flags
    out["overload"] = "OVER" in flags

    def num(k):
        try:
            return float(vars_[k])
        except (KeyError, ValueError):
            return None

    if (c := num("battery.charge")) is not None:
        out["battery"] = int(round(c))
    if (r := num("battery.runtime")) is not None:
        out["runtime"] = round(r / 60, 1)
    if (l := num("ups.load")) is not None:
        out["load"] = round(l, 1)
    for src, dst in (("input.voltage", "input_voltage"), ("output.voltage", "output_voltage")):
        if (v := num(src)) is not None:
            out[dst] = round(v, 1)
    p = num("ups.realpower")
    if p is None and (nom := num("ups.realpower.nominal")) is not None and l is not None:
        p = nom * l / 100
    if p is not None:
        out["power"] = round(p)
    return out


UPS_CAPS = ["ups_status", "battery", "runtime", "load", "input_voltage", "output_voltage", "power"]


# ------------------------------------------------------------------ adapter
class NutAdapter(Adapter):
    source = "nut"

    def __init__(self, hub, cfg):
        super().__init__(hub, cfg)
        self.poll_seconds = max(2.0, float(cfg.get("poll_seconds", 5)))
        self.servers: list[dict] = [s for s in (cfg.get("servers") or []) if isinstance(s, dict)]
        self.server_status: dict[str, str] = {}          # "host:port" -> "ok" / "error: ..."
        self._last_vars: dict[str, tuple[dict, float]] = {}

    async def start(self):
        if not any(s.get("host") for s in self.servers):
            self.status = "no UPS servers configured"
        for i, s in enumerate(self.servers):
            if s.get("host"):
                self.server_status[self._skey(s)] = "starting"
                self.spawn(f"poll{i}", lambda s=s: self._poll_forever(s), max_delay=10)

    @staticmethod
    def _skey(s: dict) -> str:
        try:
            port = int(s.get("port") or 3493)
        except (TypeError, ValueError):
            port = s.get("port")
        return f"{s.get('host')}:{port}"

    def _set_server_status(self, key: str, st: str) -> None:
        """One status per server; the adapter's status line summarises all of them."""
        self.server_status[key] = st
        bad = {k: v for k, v in self.server_status.items() if v != "ok" and v != "starting"}
        if not bad:
            self.status = "ok" if any(v == "ok" for v in self.server_status.values()) else "starting"
        elif len(self.server_status) == 1:
            self.status = next(iter(bad.values()))
        else:
            ok = sum(1 for v in self.server_status.values() if v == "ok")
            first = next(iter(bad.items()))
            self.status = f"error: {ok}/{len(self.server_status)} UPS servers ok · {first[0]}: {first[1]}"

    def ups_id(self, host: str, port: int, ups: str) -> str:
        # one id per (host, port, UPS name): several NUT servers may share a host, and UniFi calls every UPS "UPS"
        return self.dev_id(f"{host}~{port}~{ups}")

    async def _poll_forever(self, s: dict):
        """Poll one server forever with its own backoff and status, so one dead server doesn't hide the others."""
        key, delay = self._skey(s), 2.0
        while True:
            try:
                await self._poll_server(s)
                delay = 2.0
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self._set_server_status(key, f"error: {e}")
                self.log.warning("NUT %s: %s (retry in %.0fs)", key, e, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def _poll_server(self, s: dict):
        host, port = s["host"], int(s.get("port", 3493))
        key = self._skey(s)
        client = NutClient(host, port, s.get("username") or None, s.get("password") or None)
        mine: list[str] = []
        try:
            await client.connect()
            names = await client.list_ups()
            if s.get("ups"):
                names = {n: d for n, d in names.items() if n == s["ups"]}
            for ups, desc in names.items():
                did = self.ups_id(host, port, ups)
                mine.append(did)
                if did not in self.hub.devices:
                    label = desc or ups
                    # one server with several UPSes: "Name · each UPS" so they don't all look alike
                    name = (f"{s['name']} · {label}" if len(names) > 1 else s["name"]) if s.get("name") else label
                    self.hub.upsert_device(Device(
                        id=did, name=name, source=self.source, room=s.get("room"),
                        capabilities={c: cap(c) for c in UPS_CAPS}))
            self._set_server_status(key, "ok" if names else "error: no UPS found")
            while True:
                for ups in names:
                    did = self.ups_id(host, port, ups)
                    v = await client.list_vars(ups)
                    dev = self.hub.devices[did]
                    if dev.model is None:
                        dev.model = " ".join(x for x in (v.get("device.mfr") or v.get("ups.mfr"),
                                                         v.get("device.model") or v.get("ups.model")) if x) or None
                    now = time.monotonic()
                    last = self._last_vars.get(did)
                    if last and last[0] == v and dev.online and now - last[1] < REPUBLISH_SECONDS:
                        dev.last_seen = time.time()     # nothing changed: don't re-send every variable to browsers
                        continue
                    self._last_vars[did] = (v, now)
                    self.hub.set_attributes(did, {"nut_vars": v, "nut_host": f"{host}:{port}", "nut_ups": ups})
                    self.hub.set_values(did, parse_status(v), online=True)
                await asyncio.sleep(self.poll_seconds)
        except Exception:
            for did in mine:
                self._last_vars.pop(did, None)
                if did in self.hub.devices:
                    self.hub.set_values(did, {}, online=False)
            raise
        finally:
            await client.close()
