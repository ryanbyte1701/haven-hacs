from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from ..models import Device


class Adapter:
    source = "base"

    def __init__(self, hub, cfg: dict) -> None:
        self.hub = hub
        self.cfg = cfg or {}
        self.status = "starting"
        self.log = logging.getLogger(self.source)
        self._tasks: list[asyncio.Task] = []
        self._fails: dict[str, int] = {}

    FAIL_LIMIT = 3

    def poll_failed(self, did: str, err: Exception | str, devices: list[str] | None = None) -> None:
        """Count consecutive read failures; after FAIL_LIMIT the device shows offline, and when every
        device is failing the integration status says so (instead of a stale "ok")."""
        n = self._fails[did] = self._fails.get(did, 0) + 1
        if n == self.FAIL_LIMIT:
            self.log.warning("%s: %s failed %d times in a row: %s", self.source, did, n, err)
            if did in self.hub.devices:
                self.hub.set_values(did, {}, online=False)
        if n >= self.FAIL_LIMIT:
            ids = devices if devices is not None else list(self._fails)
            if ids and all(self._fails.get(i, 0) >= self.FAIL_LIMIT for i in ids):
                self.status = f"error: {err}"

    def poll_ok(self, did: str) -> None:
        self._fails.pop(did, None)
        if self.status.startswith("error"):
            self.status = "ok"

    def dev_id(self, native: str) -> str:
        return f"{self.source}:{native}".replace("/", "_").replace(" ", "_")

    async def start(self) -> None:  # override
        pass

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def command(self, device: Device, capability: str, value: Any) -> None:
        raise NotImplementedError(f"{self.source} does not support commands")

    def spawn(self, name: str, factory: Callable[[], Awaitable[None]], max_delay: int = 300) -> None:
        """Run a long-lived loop forever, restarting with backoff on errors."""
        async def runner():
            delay = min(5, max_delay)
            while True:
                try:
                    await factory()
                    delay = min(5, max_delay)
                    await asyncio.sleep(delay)      # a loop that returns normally must not spin
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    self.status = f"error: {e}"
                    self.log.warning("%s failed: %s (retry in %ss)", name, e, delay)
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, max_delay)
        self._tasks.append(asyncio.create_task(runner(), name=f"{self.source}:{name}"))
