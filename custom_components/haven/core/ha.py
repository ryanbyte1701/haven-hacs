"""High availability (beta): two Havens, one active, one on standby, sharing a virtual IP.

How it works
- Each node POSTs a heartbeat to the other's /api/ha/peer/heartbeat every `heartbeat_seconds` and the
  other answers with its own status. Requests are signed with an HMAC of the shared secret (the secret
  itself never crosses the network), carry a timestamp + nonce (no replays) and the answer is signed too.
- Election (decide()): a node is ACTIVE when the peer has been silent for `failover_after` heartbeats,
  or when both are alive and it ranks higher (priority, then node_id). With preempt off an active node
  stays active until it fails. If both claim ACTIVE (a healed network partition) the lower one steps
  down at once. A node that can't reach the peer *and* can't reach its gateway / check address is the
  isolated one: it goes to FAULT instead of grabbing the address.
- ACTIVE: add the virtual IP to the interface (`ip addr add`) and announce it with gratuitous ARP
  (raw socket, needs CAP_NET_RAW), then start adapters and automations. STANDBY / FAULT / shutdown:
  remove the address and stop adapters and automations (the UI keeps working on the node's own IP).
- If the address can't be added (no host networking or NET_ADMIN) the node goes to FAULT with a clear
  message and keeps running as a single instance as long as the other node isn't active.
- Config sync: the standby pulls an allow-list of JSON files from the active node (AES-GCM encrypted
  with a key derived from the shared secret) whenever the active node's config_version changes. The
  HA section itself, node identity and TLS certificates are never synced.

HAVEN_HA_DRY_RUN=1 replaces every network change (address, ARP) with an in-memory recorder. It is for
testing two instances on one machine only.
"""
from __future__ import annotations

import asyncio
import base64
import collections
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import socket
import struct
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from . import config as config_mod
from .config import write_private

log = logging.getLogger("haven.ha")

DISABLED, STARTING, ACTIVE, STANDBY, FAULT = "disabled", "starting", "active", "standby", "fault"
STOPPING = "stopping"                      # only ever sent to the peer, on a clean shutdown
STATE_LABEL = {DISABLED: "Off", STARTING: "Starting", ACTIVE: "Active", STANDBY: "Standby", FAULT: "Fault"}
PRIORITY_BY_ROLE = {"primary": 200, "standby": 100}
MIN_SECRET = 16
HTTP_PORT, HTTPS_PORT = 1701, 1702
AUTH_HEADER, SIG_HEADER = "X-Haven-HA", "X-Haven-HA-Sig"
CLOCK_WINDOW = 300                         # seconds of clock difference tolerated between the two NASes
SYNC_EVERY = 30.0
VIP_RETRY = 30.0                           # after failing to add the address, try again this often
VIP_CHECK_EVERY = 10.0                     # re-check that the active node still holds the address
# Files copied from the active node to the standby (each optional). Never: ha_node.json, tls/, history.
SYNC_FILES = ("settings.json", "layout.json", "automations.json", "overrides.json", "users.json",
              "ecowitt_gateways.json")
LOCAL_SECTIONS = ("ha",)                   # settings.json sections every node keeps for itself
MAX_SYNC_BYTES = 8 * 1024 * 1024
NEEDS_CAPS = "Needs host networking and NET_ADMIN — see SYNOLOGY.md (High availability)"


def dry_run() -> bool:
    return os.environ.get("HAVEN_HA_DRY_RUN") == "1"


def data_dir() -> Path:
    return config_mod.DATA_DIR


def conf_dir() -> Path:
    return config_mod.conf_dir()


# ---------------------------------------------------------------- configuration
def parse_peer(peer: str) -> str:
    """'192.168.1.21', 'nas2:1701', 'https://nas2:1702' -> base URL. Raises ValueError."""
    p = (peer or "").strip().rstrip("/")
    m = re.fullmatch(r"(?:(https?)://)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?", p)
    if not m:
        raise ValueError(f"Other Haven's address {p[:80]!r}: use an IP or host name, optionally with :port "
                         "(e.g. 192.168.1.21 or https://192.168.1.21:1702)")
    scheme, host, port = m.group(1), m.group(2), m.group(3)
    port_n = int(port) if port else None
    if port_n is not None and not 0 < port_n < 65536:
        raise ValueError("Other Haven's address: port must be 1-65535")
    if not scheme:
        scheme = "https" if port_n == HTTPS_PORT else "http"
    if port_n is None:
        port_n = HTTPS_PORT if scheme == "https" else HTTP_PORT
    if host.startswith(("-", ".")) or ".." in host:
        raise ValueError(f"Other Haven's address {p[:80]!r} is not valid")
    return f"{scheme}://{host}:{port_n}"


def parse_check_address(v: str) -> tuple[str, int | None] | None:
    v = (v or "").strip()
    if not v:
        return None
    m = re.fullmatch(r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?", v)
    if not m or not 0 < int(m.group(2) or 1) < 65536:
        raise ValueError(f"Isolation check address {v[:80]!r}: use an IP or host name, optionally with :port")
    return m.group(1).strip("[]"), int(m.group(2)) if m.group(2) else None


def _int(sec: dict, key: str, default: int, lo: int, hi: int, label: str) -> int:
    v = sec.get(key)
    if v in (None, ""):
        return default
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{label}: not a number") from None
    if f != int(f) or not lo <= f <= hi:
        raise ValueError(f"{label}: use a whole number from {lo} to {hi}")
    return int(f)


class HAConfig:
    """Validated settings of the "ha" section."""

    def __init__(self, sec: dict) -> None:
        self.raw = dict(sec)
        self.role = sec.get("role") or "primary"
        if self.role not in PRIORITY_BY_ROLE:
            raise ValueError("Role: choose primary or standby")
        self.priority = _int(sec, "priority", PRIORITY_BY_ROLE[self.role], 1, 254, "Priority")
        if not str(sec.get("peer") or "").strip():
            raise ValueError("Enter the other Haven's address")
        self.peer_url = parse_peer(str(sec.get("peer")))
        self.peer_label = str(sec.get("peer")).strip()
        self.secret = str(sec.get("secret") or "")
        if len(self.secret) < MIN_SECRET:
            raise ValueError(f"Shared secret: use at least {MIN_SECRET} characters (the same on both Havens)")
        try:
            vip = ipaddress.IPv4Address(str(sec.get("vip") or "").strip())
        except ValueError:
            raise ValueError("Virtual IP: enter an IPv4 address such as 192.168.1.50") from None
        self.prefix = _int(sec, "prefix", 24, 8, 32, "Prefix length")
        net = ipaddress.IPv4Network(f"{vip}/{self.prefix}", strict=False)
        if vip.is_loopback or vip.is_multicast or vip.is_unspecified or vip.is_link_local or vip.is_reserved:
            raise ValueError("Virtual IP: use a normal, unused address on your LAN")
        if self.prefix < 31 and vip in (net.network_address, net.broadcast_address):
            raise ValueError(f"Virtual IP: {vip} is the network or broadcast address of {net}")
        self.vip = str(vip)
        iface = str(sec.get("interface") or "").strip()
        if iface and not re.fullmatch(r"[A-Za-z0-9_.@-]{1,15}", iface):
            raise ValueError("Network interface: a name like eth0, ovs_eth0 or bond0 (or empty for automatic)")
        self.interface = iface or None
        self.heartbeat = _int(sec, "heartbeat_seconds", 2, 1, 30, "Heartbeat")
        self.misses = _int(sec, "failover_after", 5, 2, 30, "Fail over after")
        self.preempt = bool(sec.get("preempt", True))
        self.sync = bool(sec.get("sync", True))
        self.verify_tls = bool(sec.get("verify_tls", False))
        self.check = parse_check_address(str(sec.get("check_address") or ""))

    @property
    def dead_after(self) -> float:
        return self.heartbeat * self.misses

    def net_key(self) -> tuple:
        return (self.vip, self.prefix, self.interface)


def validate_section(sec: dict) -> None:
    """Raise ValueError with a readable message if an enabled HA section can't work."""
    if sec.get("enabled", True):
        HAConfig(sec)


def load_config(sec: dict | None) -> HAConfig | None:
    if not isinstance(sec, dict) or not sec.get("enabled", False):
        return None
    return HAConfig(sec)


# ---------------------------------------------------------------- election (pure)
def rank(info: dict) -> tuple:
    """Higher wins. A node that handed over on purpose ("yielding") ranks below any other."""
    return (0 if info.get("yielding") else 1, int(info.get("priority") or 0), str(info.get("node_id") or ""))


def decide(me: dict, peer: dict | None, *, preempt: bool, gateway_ok: bool | None = True) -> tuple[str, str]:
    """Target state for this node.

    me / peer: {"state", "priority", "node_id", "yielding"}. peer is None when it has missed too many
    heartbeats. gateway_ok: can this node reach its gateway / check address (None = unknown)."""
    active = me.get("state") == ACTIVE
    if peer is None:
        if gateway_ok is False:
            return FAULT, "can't reach the other Haven or the network gateway: this Haven is isolated"
        return ACTIVE, "the other Haven stopped answering"
    outranks = rank(me) > rank(peer)
    pstate = peer.get("state")
    if pstate == ACTIVE:
        if active:   # both hold the address (network partition healed, or preemption): lower one steps down
            return (ACTIVE, "both were active: this Haven has the higher priority") if outranks else \
                   (STANDBY, "both were active: the other Haven has the higher priority")
        if preempt and outranks:
            return ACTIVE, "taking over from a lower-priority Haven (preempt)"
        return STANDBY, "the other Haven is active"
    if active:
        if me.get("yielding") and pstate == STANDBY:
            return STANDBY, "handing over to the other Haven"
        return ACTIVE, "still active"
    if pstate in (STANDBY, STARTING):
        return (ACTIVE, "neither was active: this Haven has the higher priority") if outranks else \
               (STANDBY, "neither was active: the other Haven has the higher priority")
    return ACTIVE, f"the other Haven can't serve ({pstate or 'unknown'})"


# ---------------------------------------------------------------- crypto / signing
def derive_keys(secret: str) -> tuple[bytes, bytes]:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    def hk(info: bytes) -> bytes:
        return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"haven-ha-v1", info=info).derive(secret.encode())
    return hk(b"auth"), hk(b"config")


def _mac(key: bytes, *parts: str | bytes) -> str:
    msg = b"\n".join(p if isinstance(p, bytes) else p.encode() for p in parts)
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


def sign_request(key: bytes, method: str, path: str, body: bytes, ts: int | None = None,
                 nonce: str | None = None) -> tuple[str, str]:
    ts = int(time.time()) if ts is None else ts
    nonce = nonce or secrets.token_hex(16)
    sig = _mac(key, "req", method.upper(), path, str(ts), nonce, hashlib.sha256(body).hexdigest())
    return f"v1:{ts}:{nonce}:{sig}", nonce


def sign_response(key: bytes, nonce: str, body: bytes) -> str:
    return _mac(key, "resp", nonce, hashlib.sha256(body).hexdigest())


class ReplayCache:
    def __init__(self) -> None:
        self.seen: dict[str, float] = {}

    def check_and_add(self, nonce: str, now: float) -> bool:
        if len(self.seen) > 5000:
            self.seen = {n: t for n, t in self.seen.items() if now - t < 2 * CLOCK_WINDOW}
        if nonce in self.seen:
            return False
        self.seen[nonce] = now
        return True


def verify_request(key: bytes, method: str, path: str, body: bytes, header: str | None,
                   replay: ReplayCache, now: float | None = None) -> tuple[bool, str, str]:
    """(ok, reason, nonce). Constant-time signature comparison; reason is "signature" or "clock"."""
    now = time.time() if now is None else now
    parts = (header or "").split(":")
    if len(parts) != 4 or parts[0] != "v1" or not re.fullmatch(r"[0-9a-f]{16,64}", parts[2]) \
            or not parts[1].isdigit() or len(parts[3]) != 64:
        # still do a comparison so a malformed header takes about as long as a wrong one
        hmac.compare_digest(_mac(key, "x"), "0" * 64)
        return False, "signature", ""
    ts, nonce, sig = int(parts[1]), parts[2], parts[3]
    want = _mac(key, "req", method.upper(), path, str(ts), nonce, hashlib.sha256(body).hexdigest())
    if not hmac.compare_digest(want.encode(), sig.encode()):
        return False, "signature", nonce
    if abs(now - ts) > CLOCK_WINDOW:
        return False, "clock", nonce
    if not replay.check_and_add(nonce, now):
        return False, "replay", nonce
    return True, "", nonce


def encrypt(key: bytes, payload: dict, aad: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), aad.encode())
    return {"iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def decrypt(key: bytes, box: dict, aad: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    plain = AESGCM(key).decrypt(base64.b64decode(box["iv"]), base64.b64decode(box["ct"]), aad.encode())
    return json.loads(plain)


# ---------------------------------------------------------------- config sync (pure-ish)
def _strip_local(name: str, obj: Any) -> Any:
    if name == "settings.json" and isinstance(obj, dict):
        return {k: v for k, v in obj.items() if k not in LOCAL_SECTIONS}
    return obj


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except Exception:  # noqa: BLE001 - unreadable/corrupt: treat as raw text for the version hash
        return {"__unreadable__": hashlib.sha256(path.read_bytes()).hexdigest()}


def export_config(ddir: Path) -> dict[str, Any]:
    """The allow-listed files as parsed JSON, without this node's own HA section."""
    out = {}
    for name in SYNC_FILES:
        obj = _read_json(ddir / name)
        if obj is not None and not (isinstance(obj, dict) and "__unreadable__" in obj):
            out[name] = _strip_local(name, obj)
    return out


def config_version(ddir: Path) -> str:
    h = hashlib.sha256()
    for name in SYNC_FILES:
        obj = _read_json(ddir / name)
        if obj is None:
            continue
        h.update(name.encode() + b"\0" + json.dumps(_strip_local(name, obj), sort_keys=True).encode() + b"\0")
    return h.hexdigest()[:16]


def apply_config(ddir: Path, files: dict[str, Any]) -> list[str]:
    """Write the peer's files (allow-list only, atomically, 0600). Each node keeps its own HA section.
    Returns the names that changed."""
    if not isinstance(files, dict):
        raise ValueError("bad config payload")
    for name in SYNC_FILES:                      # check everything before writing anything
        if name in files and not isinstance(files[name], (dict, list)):
            raise ValueError(f"{name}: not a JSON object")
    changed = []
    for name in SYNC_FILES:                      # only ever these names: never a path from the peer
        if name not in files:
            continue                             # missing on the active node: keep ours
        obj = files[name]
        path = ddir / name
        if name == "settings.json":
            obj = _strip_local(name, obj)
            local = _read_json(path)
            for sec in LOCAL_SECTIONS:
                if isinstance(local, dict) and sec in local:
                    obj = {**obj, sec: local[sec]}
        cur = _read_json(path)
        if cur is not None and json.dumps(cur, sort_keys=True) == json.dumps(obj, sort_keys=True):
            continue
        write_private(path, json.dumps(obj, indent=2))
        changed.append(name)
    return changed


# ---------------------------------------------------------------- network layer
def _hex_ip(h: str) -> int:
    # the kernel prints the network-order u32 as a native (little-endian) integer: compare like with like
    return int(h, 16)


def read_routes(text: str | None = None) -> list[tuple[str, int, int, int]]:
    """(iface, dest, gateway, mask) as host-order ints from /proc/net/route."""
    if text is None:
        try:
            text = Path("/proc/net/route").read_text()
        except OSError:
            return []
    out = []
    for line in text.splitlines()[1:]:
        f = line.split()
        if len(f) >= 8:
            try:
                out.append((f[0], _hex_ip(f[1]), _hex_ip(f[2]), _hex_ip(f[7])))
            except ValueError:
                continue
    return out


def _le(ip: str) -> int:
    return struct.unpack("<I", ipaddress.IPv4Address(ip).packed)[0]


def route_iface(vip: str, routes: list | None = None) -> str | None:
    """The interface with the most specific route to the VIP's subnet (ignoring the default route
    unless nothing else matches)."""
    routes = read_routes() if routes is None else routes
    target = _le(vip)
    best = None
    for iface, dest, _gw, mask in routes:
        if iface == "lo" or (target & mask) != dest:
            continue
        bits = bin(mask).count("1")
        if best is None or bits > best[0]:
            best = (bits, iface)
    return best[1] if best else None


def default_gateway(routes: list | None = None) -> str | None:
    routes = read_routes() if routes is None else routes
    for _iface, dest, gw, mask in routes:
        if dest == 0 and mask == 0 and gw:
            return str(ipaddress.IPv4Address(struct.pack("<I", gw)))
    return None


def garp_frame(mac: bytes, ip: str, reply: bool = False) -> bytes:
    """Ethernet broadcast gratuitous ARP for `ip` from `mac`."""
    ipb = ipaddress.IPv4Address(ip).packed
    eth = b"\xff" * 6 + mac + struct.pack("!H", 0x0806)
    arp = struct.pack("!HHBBH", 1, 0x0800, 6, 4, 2 if reply else 1)
    target_mac = mac if reply else b"\x00" * 6
    arp += mac + ipb + target_mac + ipb
    return eth + arp


Runner = Callable[[list[str]], Awaitable[tuple[int, str, str]]]


async def run_cmd(argv: list[str]) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, "", "timed out"
    return proc.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def tcp_reachable(host: str, ports: tuple[int, ...] = (53, 80, 443), timeout: float = 1.5) -> bool:
    """True if the host answers at all: an accepted *or refused* TCP connection proves it's there."""
    async def one(port: int) -> bool:
        try:
            _r, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
            w.close()
            return True
        except ConnectionRefusedError:
            return True
        except Exception:  # noqa: BLE001 - timeout / unreachable
            return False
    results = await asyncio.gather(*(one(p) for p in ports))
    return any(results)


class LinuxNet:
    """Adds/removes the virtual IP with iproute2 and announces it with gratuitous ARP."""

    dry_run = False

    def __init__(self, run: Runner | None = None) -> None:
        self.run = run or run_cmd

    @staticmethod
    def ip_bin() -> str | None:
        return shutil.which("ip") or next((p for p in ("/usr/sbin/ip", "/sbin/ip", "/bin/ip") if os.path.exists(p)), None)

    @staticmethod
    def label(iface: str) -> str | None:
        lbl = f"{iface}:haven"
        return lbl if len(lbl) <= 15 else None

    def add_argv(self, vip: str, prefix: int, iface: str) -> list[str]:
        argv = [self.ip_bin() or "ip", "addr", "add", f"{vip}/{prefix}", "dev", iface]
        lbl = self.label(iface)
        return argv + (["label", lbl] if lbl else [])

    def del_argv(self, vip: str, prefix: int, iface: str) -> list[str]:
        return [self.ip_bin() or "ip", "addr", "del", f"{vip}/{prefix}", "dev", iface]

    @staticmethod
    def explain(err: str, iface: str) -> str:
        e = err.strip()
        if re.search(r"not permitted|permission denied", e, re.I):
            return NEEDS_CAPS
        if re.search(r"cannot find device|does not exist", e, re.I):
            return f"Network interface {iface!r} not found. {NEEDS_CAPS}"
        return f"Couldn't add the virtual IP: {e[:160] or 'unknown error'}"

    def detect_iface(self, vip: str) -> str | None:
        return route_iface(vip)

    async def add_vip(self, vip: str, prefix: int, iface: str) -> tuple[bool, str]:
        if not self.ip_bin():
            return False, "The ip command (iproute2) is missing: use the Haven image from ghcr.io. " + NEEDS_CAPS
        clash = await self.vip_clash(vip, iface)
        if clash:
            return False, clash
        rc, _out, err = await self.run(self.add_argv(vip, prefix, iface))
        if rc == 0 or re.search(r"file exists|already assigned", err, re.I):    # old / new iproute2 wording
            return True, ""
        return False, self.explain(err, iface)

    async def vip_clash(self, vip: str, iface: str) -> str:
        """Why this virtual IP must not be claimed here, or "". Never take the router's address, and never
        add (and later delete) an address this NAS already has for itself: that would cut the NAS off."""
        if vip == default_gateway():
            return f"Virtual IP {vip} is your router's address: pick a free address outside the DHCP range"
        rc, out, _err = await self.run([self.ip_bin(), "-o", "-4", "addr", "show"])
        if rc != 0:
            return ""
        lbl = self.label(iface)
        for line in out.splitlines():
            if re.search(rf"\binet {re.escape(vip)}/", line) and not (lbl and line.rstrip().split("\\")[0].rstrip().endswith(lbl)):
                return (f"Virtual IP {vip} is already one of this NAS's own addresses: pick a free address "
                        "that no device uses")
        return ""

    async def del_vip(self, vip: str, prefix: int, iface: str) -> tuple[bool, str]:
        if not self.ip_bin():
            return True, ""
        rc, _out, err = await self.run(self.del_argv(vip, prefix, iface))
        if rc == 0 or re.search(r"cannot assign requested address|address not found|cannot find device", err, re.I):
            return True, ""
        return False, err.strip()[:160]

    async def has_vip(self, vip: str, iface: str) -> bool | None:
        if not self.ip_bin():
            return None
        rc, out, _err = await self.run([self.ip_bin(), "-o", "-4", "addr", "show", "dev", iface])
        if rc != 0:
            return None
        return re.search(rf"\binet {re.escape(vip)}/", out) is not None

    async def announce(self, vip: str, iface: str) -> tuple[bool, str]:
        """One round of gratuitous ARP (request + reply) so switches and hosts learn the new MAC."""
        try:
            with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0806)) as s:
                s.bind((iface, 0))
                mac = s.getsockname()[4]           # the interface's hardware address
                if len(mac) != 6:
                    return False, f"{iface} has no Ethernet address"
                s.send(garp_frame(mac, vip, reply=False))
                s.send(garp_frame(mac, vip, reply=True))
            return True, ""
        except (OSError, AttributeError) as e:     # AttributeError: no AF_PACKET (not Linux)
            arping = shutil.which("arping")
            if arping:
                rc, _o, err = await self.run([arping, "-U", "-c", "1", "-I", iface, vip])
                if rc == 0:
                    return True, ""
            return False, f"gratuitous ARP failed ({e}); needs NET_RAW"

    async def gateway_ok(self, check: tuple[str, int | None] | None) -> bool | None:
        if check:
            host, port = check
            return await tcp_reachable(host, (port,) if port else (53, 80, 443))
        gw = default_gateway()
        if not gw:
            return None
        return await tcp_reachable(gw)


class DryRunNet(LinuxNet):
    """HAVEN_HA_DRY_RUN=1: records what would be done instead of touching the network (testing only)."""

    dry_run = True

    def __init__(self) -> None:
        super().__init__(run=self._fake)
        self.ops: list[tuple] = []
        self.addrs: set[tuple[str, str]] = set()

    async def _fake(self, argv):  # pragma: no cover - never used
        return 0, "", ""

    def detect_iface(self, vip: str) -> str | None:
        return route_iface(vip) or "dry0"

    async def add_vip(self, vip, prefix, iface):
        self.ops.append(("add", vip, prefix, iface))
        self.addrs.add((vip, iface))
        return True, ""

    async def del_vip(self, vip, prefix, iface):
        self.ops.append(("del", vip, prefix, iface))
        self.addrs.discard((vip, iface))
        return True, ""

    async def has_vip(self, vip, iface):
        return (vip, iface) in self.addrs

    async def announce(self, vip, iface):
        self.ops.append(("garp", vip, iface))
        return True, ""

    async def gateway_ok(self, check):
        return True


# ---------------------------------------------------------------- the manager
def _load_node_id(ddir: Path) -> str:
    path = ddir / "ha_node.json"
    try:
        nid = json.loads(path.read_text()).get("node_id")
        if isinstance(nid, str) and re.fullmatch(r"[0-9a-f]{8,64}", nid):
            return nid
    except Exception:  # noqa: BLE001
        pass
    return _new_node_id(ddir)


def _new_node_id(ddir: Path) -> str:
    nid = secrets.token_hex(8)
    try:
        write_private(ddir / "ha_node.json", json.dumps({"node_id": nid}))
    except OSError as e:
        log.warning("can't save the HA node id: %s", e)
    return nid


class HAManager:
    def __init__(self, net: LinuxNet | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.data_dir: Callable[[], Path] = data_dir
        self.conf_dir: Callable[[], Path] = conf_dir     # the synced files live in the config folder
        self.cfg: HAConfig | None = None
        self.net = net
        self.state = DISABLED
        self.since = time.time()
        self.message = ""
        self.warning = ""                      # shown while things still work (e.g. ARP failed, peer misconfigured)
        self.fault_kind = ""                   # "vip" | "isolated" | "peer" | "self" | "config"
        self.node_id = ""
        self.instance = secrets.token_hex(8)   # tells "the peer address points at me" apart from a cloned data folder
        self.yielding = False
        self.iface: str | None = None
        self.has_vip = False
        self.last_failover: dict | None = None
        self.events: collections.deque = collections.deque(maxlen=20)
        self.peer: dict | None = None          # last verified status from the peer
        self.peer_seen = 0.0                   # monotonic time of the last verified contact
        self.peer_rtt: float | None = None
        self.peer_problem = ""                 # why the last attempt to talk to the peer failed
        self.peer_problem_at = 0.0
        self.peer_contact = 0.0                # the peer answered at all (even with an error)
        self.gateway: bool | None = None
        self.sync_info: dict = {"last": None, "error": None, "changed": []}
        self.services_on: bool | None = None
        self.services: Callable[[bool], Awaitable[None]] | None = None    # set by main: start/stop adapters+automations
        self.on_synced: Callable[[list[str]], Awaitable[None]] | None = None
        self.on_settings_saved: Callable[[], None] | None = None          # main: refresh its config copy
        self.read_section: Callable[[], dict] = lambda: _ha_section()      # the saved "ha" settings (tests swap these)
        self.write_section: Callable[[dict], None] = lambda values: _write_ha(values)
        self.replay = ReplayCache()
        self._keys: tuple[bytes, bytes] | None = None
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._started = 0.0
        self._vip_try = 0.0
        self._vip_check = 0.0
        self._last_sync_try = 0.0
        self._synced_version: str | None = None
        self._tried_version: str | None = None
        self._bg: set[asyncio.Task] = set()
        self._client = None
        self._client_verify: bool | None = None

    # ----- helpers
    @property
    def enabled(self) -> bool:
        return self.cfg is not None

    def _spawn(self, coro) -> None:
        t = asyncio.get_running_loop().create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    def priority(self) -> int:
        return self.cfg.priority if self.cfg else 0

    def peer_alive(self, now: float | None = None) -> bool:
        now = self.clock() if now is None else now
        return bool(self.cfg and self.peer and self.peer_seen and now - self.peer_seen <= self.cfg.dead_after)

    def my_info(self) -> dict:
        return {"node_id": self.node_id, "instance": self.instance, "priority": self.priority(),
                "role": self.cfg.role if self.cfg else None, "state": self.state, "since": self.since,
                "yielding": self.yielding, "vip": self.cfg.vip if self.cfg else None,
                "config_version": config_version(self.conf_dir()), "proto": 1}

    def note(self, reason: str) -> None:
        """An event that isn't a state change (pairing, hand-over requests) for the HA events list."""
        self._event(self.state, self.state, reason)

    def _event(self, frm: str, to: str, reason: str) -> None:
        self.events.appendleft({"ts": time.time(), "from": frm, "to": to, "reason": reason})
        log.warning("HA: %s -> %s (%s)", frm, to, reason)

    def _set_state(self, state: str, reason: str, message: str = "", kind: str = "") -> None:
        if state != self.state or kind != self.fault_kind:
            old = self.state
            self._event(old, state, message or reason)
            if state == ACTIVE and old not in (ACTIVE, DISABLED) and not reason.startswith("neither"):
                self.last_failover = {"ts": time.time(), "to": "this", "reason": reason}
            elif old == ACTIVE and state not in (ACTIVE, DISABLED):
                self.last_failover = {"ts": time.time(), "to": "peer", "reason": reason}
            self.state, self.since = state, time.time()
        self.message, self.fault_kind = message, kind
        if state != ACTIVE:
            self.warning = ""

    def want_services(self) -> bool | None:
        """None = leave as is."""
        if self.state in (DISABLED, ACTIVE):
            return True
        if self.state == STARTING:
            return None
        if self.state == FAULT and self.fault_kind == "config":
            return True                        # broken HA settings must not take the whole app down
        if self.state == FAULT and self.fault_kind == "vip":
            # can't hold the address: still serve as a single instance unless the other node is active
            return not (self.peer_alive() and (self.peer or {}).get("state") == ACTIVE)
        return False

    async def _apply_services(self) -> None:
        want = self.want_services()
        if want is None or want == self.services_on or not self.services:
            return
        self.services_on = want
        try:
            await self.services(want)
        except Exception as e:  # noqa: BLE001
            log.error("HA: %s services failed: %s", "starting" if want else "stopping", e)

    # ----- lifecycle
    async def configure(self, sec: dict | None) -> None:
        """Apply the "ha" settings section (at startup and after Settings → Save)."""
        try:
            new = load_config(sec)
            err = ""
        except ValueError as e:
            new, err = None, str(e)
        old = self.cfg
        await self._stop_loop()
        async with self._lock:
            if old and self.has_vip and (new is None or new.net_key() != old.net_key()):
                await self._drop_vip(old)
            self._keys = derive_keys(new.secret) if new else None
            self.cfg = new
            if self.net is None or self.net.dry_run != dry_run():
                self.net = DryRunNet() if dry_run() else LinuxNet()
            if new is None:
                self.peer, self.peer_seen, self.yielding = None, 0.0, False
                if err:
                    log.error("High availability settings problem: %s", err)
                    self._set_state(FAULT, "settings problem", f"Settings problem: {err}", "config")
                else:
                    self._set_state(DISABLED, "turned off")
                await self._apply_services()
                return
            self.node_id = self.node_id or _load_node_id(self.data_dir())
            self.iface = new.interface or self.net.detect_iface(new.vip)
            if old is None:
                self._set_state(STARTING, "starting", f"Waiting for {new.peer_label}")
                self._started = self.clock()
        self._task = asyncio.get_running_loop().create_task(self._loop())

    async def _stop_loop(self) -> None:
        t, self._task = self._task, None
        if t and not t.done():
            t.cancel()
            await asyncio.gather(t, return_exceptions=True)

    async def stop(self) -> None:
        """Shutdown: never leave the address configured. Tell the peer so it takes over right away."""
        await self._stop_loop()
        if not self.cfg:
            return
        async with self._lock:
            await self._drop_vip(self.cfg, force=True)
            if self.state == ACTIVE:
                self._set_state(STANDBY, "shutting down")
        try:
            info = {**self.my_info(), "state": STOPPING}
            await asyncio.wait_for(self._post("/api/ha/peer/heartbeat", info), 2)
        except Exception:  # noqa: BLE001
            pass
        for t in list(self._bg):
            t.cancel()
        if self._client:
            await self._client.aclose()
            self._client = None

    # ----- network actions
    async def _drop_vip(self, cfg: HAConfig, force: bool = False) -> None:
        iface = self.iface or cfg.interface or self.net.detect_iface(cfg.vip)
        if not iface or not (self.has_vip or force):
            self.has_vip = False
            return
        ok, err = await self.net.del_vip(cfg.vip, cfg.prefix, iface)
        if not ok:
            log.error("HA: couldn't remove %s from %s: %s", cfg.vip, iface, err)
        self.has_vip = False

    async def _take_vip(self) -> tuple[bool, str]:
        cfg = self.cfg
        self.iface = cfg.interface or self.net.detect_iface(cfg.vip)
        if not self.iface:
            return False, (f"No network interface is on {cfg.vip}'s subnet: set the interface under Advanced, "
                           f"or check the virtual IP. {NEEDS_CAPS}")
        self._vip_try = self.clock()
        ok, err = await self.net.add_vip(cfg.vip, cfg.prefix, self.iface)
        if not ok:
            return False, err
        self.has_vip = True
        self._vip_check = self.clock()
        self._spawn(self._announce_burst(cfg.vip, self.iface))
        return True, ""

    async def _announce_burst(self, vip: str, iface: str, count: int = 3) -> None:
        for i in range(count):
            ok, err = await self.net.announce(vip, iface)
            if not ok:
                log.warning("HA: %s", err)
                if self.state == ACTIVE:
                    self.warning = f"Gratuitous ARP failed ({err}); other devices may take a minute to switch"
                return
            if i + 1 < count:
                await asyncio.sleep(1)

    # ----- the loop
    async def _loop(self) -> None:
        while self.cfg:
            try:
                await self._beat()
                await self._maybe_sync()
                await self.evaluate()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.exception("HA loop error: %s", e)
            try:
                await asyncio.wait_for(self._wake.wait(), self.cfg.heartbeat)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()

    def kick(self) -> None:
        """Re-evaluate and heartbeat now (e.g. after a state change), without blocking the caller."""
        self._wake.set()

    def _http(self):
        import httpx
        if self._client is None or self._client_verify != self.cfg.verify_tls:
            if self._client:
                self._spawn(self._client.aclose())
            self._client = httpx.AsyncClient(verify=self.cfg.verify_tls, follow_redirects=False, trust_env=False,
                                             timeout=httpx.Timeout(max(1.0, min(3.0, self.cfg.heartbeat * 0.9))))
            self._client_verify = self.cfg.verify_tls
        return self._client

    async def _request(self, method: str, path: str, payload: dict | None = None):
        """Signed request to the peer. Returns (status, body bytes, nonce)."""
        auth, _ = self._keys
        body = json.dumps(payload).encode() if payload is not None else b""
        header, nonce = sign_request(auth, method, path, body)
        r = await self._http().request(method, self.cfg.peer_url + path, content=body or None,
                                       headers={AUTH_HEADER: header, "content-type": "application/json"})
        return r, nonce

    def _problem(self, what: str) -> None:
        self.peer_problem, self.peer_problem_at = what, self.clock()

    def _check_response(self, r, nonce: str) -> bool:
        self.peer_contact = self.clock()
        if r.status_code in (401, 403):
            reason = ""
            try:
                reason = r.json().get("reason", "")
            except Exception:  # noqa: BLE001
                pass
            self._problem({"clock": "clock", "replay": "secret"}.get(reason, "secret"))
            return False
        if r.status_code == 409:
            self._problem("ha_off")
            return False
        if r.status_code == 404:
            self._problem("version")
            return False
        if r.status_code != 200:
            self._problem(f"http {r.status_code}")
            return False
        if not hmac.compare_digest(sign_response(self._keys[0], nonce, r.content).encode(),
                                   r.headers.get(SIG_HEADER, "").encode()):
            self._problem("secret")
            return False
        return True

    async def _post(self, path: str, payload: dict):
        r, nonce = await self._request("POST", path, payload)
        return r.json() if self._check_response(r, nonce) else None

    async def _beat(self) -> None:
        t0 = self.clock()
        try:
            resp = await self._post("/api/ha/peer/heartbeat", self.my_info())
        except Exception as e:  # noqa: BLE001 - unreachable / timeout
            self._problem("unreachable")
            log.debug("HA heartbeat to %s failed: %s", self.cfg.peer_url, e)
            return
        if resp is None:
            return
        self.peer_rtt = self.clock() - t0
        self._record_peer(resp)

    def _record_peer(self, info: dict) -> None:
        if not isinstance(info, dict):
            return
        info = {k: info.get(k) for k in ("node_id", "instance", "priority", "role", "state", "since", "yielding",
                                         "vip", "config_version")}
        if info.get("instance") == self.instance:
            self._problem("self")
            return
        if info.get("node_id") == self.node_id:      # a copied data folder: pick a new identity
            self.node_id = _new_node_id(self.data_dir())
        try:
            info["priority"] = int(info.get("priority") or 0)
        except (TypeError, ValueError):
            info["priority"] = 0
        self.peer = info
        self.peer_seen = self.clock()
        self.peer_problem = ""

    async def on_heartbeat(self, info: dict) -> dict:
        """Called for a verified heartbeat from the peer."""
        prev = (self.peer or {}).get("state")
        self._record_peer(info)
        if self.peer_problem == "self":
            return self.my_info()
        if info.get("state") != prev or (info.get("state") == ACTIVE and self.state == ACTIVE) \
                or info.get("state") == STOPPING:
            self.kick()
        return self.my_info()

    async def on_yield_request(self) -> dict:
        """The peer's admin pressed "Take over now": step down if we're active."""
        self.yielding = True
        self.kick()
        return self.my_info()

    # ----- election
    async def evaluate(self) -> None:
        if not self.cfg:
            return
        async with self._lock:
            await self._evaluate()
            await self._apply_services()

    async def _evaluate(self) -> None:
        cfg, now = self.cfg, self.clock()
        alive = self.peer_alive(now)
        peer = self.peer if alive else None
        if peer and peer.get("state") == STOPPING:
            peer = None                              # it told us it's going away: don't wait for the timeout
        if self.peer_problem == "self" and now - self.peer_problem_at < cfg.dead_after:
            if self.state == ACTIVE:
                await self._drop_vip(cfg)
            self._set_state(FAULT, "misconfigured", "The other Haven's address points at this Haven: enter the "
                            "other NAS's own IP address.", "self")
            return
        verify_problem = self.peer_problem_recent(now) and self.peer_problem != "unreachable"
        if self.state == STARTING and peer is None and not verify_problem and now - self._started < cfg.dead_after:
            return                                   # give the peer a chance to answer before deciding
        if peer is None and verify_problem and now - self.peer_contact < cfg.dead_after:
            # the peer is there but we can't verify it: never grab the address on a guess
            msg = self.problem_text()
            if self.state == ACTIVE:
                self.warning = msg
                return                               # keep serving; the other side is the one that can't join
            if self.state != FAULT or self.fault_kind != "peer" or self.message != msg:
                await self._drop_vip(cfg)
                self._set_state(FAULT, "peer problem", msg, "peer")
            return
        gateway_ok = True
        if peer is None:
            gateway_ok = self.gateway = await self.net.gateway_ok(cfg.check)
        me = {"state": self.state, "priority": cfg.priority, "node_id": self.node_id, "yielding": self.yielding}
        target, reason = decide(me, peer, preempt=cfg.preempt, gateway_ok=gateway_ok)
        if target == ACTIVE:
            if self.state == ACTIVE:
                if self.warning and not self.warning.startswith("Gratuitous"):
                    self.warning = ""
                await self._ensure_vip(now)
                if not peer and self.yielding:
                    self.yielding = False
                return
            if self.state == FAULT and self.fault_kind == "vip" and now - self._vip_try < VIP_RETRY:
                return                               # don't hammer `ip` every heartbeat
            if reason.startswith("taking over") and cfg.sync and peer \
                    and peer.get("config_version") != config_version(self.conf_dir()):
                await self._sync()                   # pick up changes made while we were away first
            ok, err = await self._take_vip()
            if not ok:
                self._set_state(FAULT, reason, err, "vip")
                return
            self.yielding = False
            self._set_state(ACTIVE, reason, "")
            self.kick()
            return
        if target == STANDBY:
            if self.state != STANDBY or self.has_vip:
                await self._drop_vip(cfg)
                self._set_state(STANDBY, reason, "")
                self.kick()
            return
        if self.state != FAULT or self.fault_kind != "isolated":
            await self._drop_vip(cfg)
            self._set_state(FAULT, reason, "Can't reach the other Haven or the router: this NAS looks cut off "
                            "from the network, so it gave up the virtual IP.", "isolated")

    def peer_problem_recent(self, now: float) -> bool:
        return bool(self.peer_problem) and now - self.peer_problem_at < (self.cfg.dead_after if self.cfg else 10)

    def problem_text(self) -> str:
        return {
            "secret": "The other Haven rejected our heartbeat: the shared secret differs. Enter the same secret on both.",
            "clock": "The two NASes' clocks differ by more than 5 minutes: turn on NTP time sync on both.",
            "ha_off": "High availability is off on the other Haven.",
            "version": "The other Haven doesn't support high availability: update it.",
            "self": "The other Haven's address points at this Haven.",
            "unreachable": "Can't reach the other Haven.",
        }.get(self.peer_problem, f"The other Haven answered with an error ({self.peer_problem}).")

    async def _ensure_vip(self, now: float) -> None:
        """Self-heal: put the address back if something (e.g. a DSM network restart) removed it."""
        if now - self._vip_check < VIP_CHECK_EVERY:
            return
        self._vip_check = now
        held = await self.net.has_vip(self.cfg.vip, self.iface or "")
        if held is False:
            log.warning("HA: %s disappeared from %s, adding it again", self.cfg.vip, self.iface)
            ok, err = await self._take_vip()
            if not ok:
                self._set_state(FAULT, "lost the virtual IP", err, "vip")
        elif held:
            self.has_vip = True

    # ----- config sync
    async def _maybe_sync(self) -> None:
        cfg = self.cfg
        if not cfg.sync or self.state == ACTIVE or not self.peer_alive() or (self.peer or {}).get("state") != ACTIVE:
            return
        theirs = self.peer.get("config_version")
        if theirs == config_version(self.conf_dir()):
            return                                   # already identical
        # a new version: fetch now; the same version again (it didn't converge, or failed): every 30 s
        if theirs == self._tried_version and self.clock() - self._last_sync_try < SYNC_EVERY:
            return
        self._tried_version = theirs
        await self._sync()

    async def _sync(self) -> list[str]:
        self._last_sync_try = self.clock()
        try:
            r, nonce = await self._request("GET", "/api/ha/peer/config")
            if not self._check_response(r, nonce):
                raise RuntimeError(self.problem_text())
            if len(r.content) > MAX_SYNC_BYTES * 2:
                raise RuntimeError("settings from the other Haven are too large")
            payload = decrypt(self._keys[1], r.json(), nonce)
            self._synced_version = payload.get("version")
            changed = apply_config(self.conf_dir(), payload.get("files") or {})
            self.sync_info = {"last": time.time(), "error": None, "changed": changed}
            if changed:
                log.info("HA: copied %s from the active Haven", ", ".join(changed))
                if self.on_synced:
                    await self.on_synced(changed)
            return changed
        except Exception as e:  # noqa: BLE001
            self.sync_info = {**self.sync_info, "error": str(e)[:200], "error_at": time.time()}
            log.warning("HA: config sync failed: %s", e)
            return []

    # ----- served to the peer
    def authenticate(self, method: str, path: str, body: bytes, header: str | None) -> tuple[bool, str, str]:
        if not self._keys:
            return False, "ha_off", ""
        return verify_request(self._keys[0], method, path, body, header, self.replay)

    def signed(self, payload: dict, nonce: str) -> Response:
        body = json.dumps(payload).encode()
        return Response(body, media_type="application/json",
                        headers={SIG_HEADER: sign_response(self._keys[0], nonce, body), "Cache-Control": "no-store"})

    def config_payload(self, nonce: str) -> dict:
        files = export_config(self.conf_dir())
        size = len(json.dumps(files))
        if size > MAX_SYNC_BYTES:
            raise HTTPException(413, "settings too large to sync")
        return encrypt(self._keys[1], {"files": files, "version": config_version(self.conf_dir())}, nonce)

    # ----- admin actions
    async def failover(self, action: str = "auto") -> dict:
        if not self.cfg:
            raise HTTPException(409, "High availability is off")
        if action == "auto":
            action = "handover" if self.state == ACTIVE else "takeover"
        if action == "handover":
            if self.state != ACTIVE:
                raise HTTPException(409, "This Haven isn't active, so there's nothing to hand over")
            if not self.peer_alive() or (self.peer or {}).get("state") != STANDBY:
                raise HTTPException(409, "The other Haven isn't on standby and reachable, so it can't take over")
            self.yielding = True
            self._event(self.state, self.state, "handover requested")
            await self.evaluate()
            return self.status()
        if action == "takeover":
            if self.state == ACTIVE:
                raise HTTPException(409, "This Haven is already active")
            self.yielding = False
            if self.peer_alive():
                try:
                    if await self._post("/api/ha/peer/yield", {}) is None:
                        raise RuntimeError(self.problem_text())
                except Exception as e:  # noqa: BLE001
                    raise HTTPException(502, f"The other Haven didn't hand over: {e}") from e
            self._event(self.state, self.state, "takeover requested")
            self.kick()
            return self.status()
        raise HTTPException(400, "action must be handover or takeover")

    # ----- reporting
    def brief(self) -> dict | None:
        if not self.cfg and self.state == DISABLED:
            return None
        peer_host = self.cfg.peer_label if self.cfg else ""
        return {"state": self.state, "message": self.message or self.warning, "vip": self.cfg.vip if self.cfg else None,
                "peer": peer_host, "peer_state": (self.peer or {}).get("state") if self.peer_alive() else None}

    def status_line(self) -> str | None:
        if not self.cfg:
            return f"fault: {self.message}" if self.state == FAULT else None
        if self.state == ACTIVE:
            return f"active: holds {self.cfg.vip}" + (" (test mode)" if self.net and self.net.dry_run else "")
        if self.state == STANDBY:
            return f"standby: {self.cfg.peer_label} is active" if (self.peer or {}).get("state") == ACTIVE \
                else "standby"
        if self.state == STARTING:
            return f"starting: waiting for {self.cfg.peer_label}"
        return f"fault: {self.message}"

    def status(self) -> dict:
        now = self.clock()
        cfg = self.cfg
        alive = self.peer_alive(now)
        return {
            "enabled": bool(cfg), "state": self.state, "state_label": STATE_LABEL.get(self.state, self.state),
            "message": self.message, "warning": self.warning, "fault": self.fault_kind or None, "since": self.since,
            "role": cfg.role if cfg else None, "priority": cfg.priority if cfg else None, "node_id": self.node_id,
            "preempt": cfg.preempt if cfg else None, "yielding": self.yielding,
            "vip": cfg.vip if cfg else None, "prefix": cfg.prefix if cfg else None, "interface": self.iface,
            "has_vip": self.has_vip, "dry_run": bool(self.net and self.net.dry_run),
            "heartbeat_seconds": cfg.heartbeat if cfg else None, "failover_after": cfg.misses if cfg else None,
            "gateway_ok": self.gateway,
            "peer": {
                "address": cfg.peer_label if cfg else None, "url": cfg.peer_url if cfg else None,
                "reachable": alive, "state": (self.peer or {}).get("state") if alive else None,
                "last_state": (self.peer or {}).get("state"),
                "priority": (self.peer or {}).get("priority"), "role": (self.peer or {}).get("role"),
                "last_heartbeat_age": round(now - self.peer_seen, 1) if self.peer_seen else None,
                "rtt_ms": round(self.peer_rtt * 1000) if self.peer_rtt is not None else None,
                "problem": self.problem_text() if self.peer_problem and self.peer_problem_recent(now) else None,
                "config_version": (self.peer or {}).get("config_version"),
            },
            "sync": {"enabled": bool(cfg and cfg.sync), "config_version": config_version(self.conf_dir()), **self.sync_info},
            "last_failover": self.last_failover, "events": list(self.events),
        }


ha = HAManager()



# ---------------------------------------------------------------- splash on a standby / adoption helpers
_LOGO: str | None = None


def _logo_path() -> str:
    global _LOGO
    if _LOGO is None:
        try:
            _LOGO = (Path(__file__).parent / "static" / "logo.svg").read_text().strip()   # Haven's logo
        except OSError:
            _LOGO = ""
    return _LOGO


def request_host(request) -> tuple[str, str | None]:
    """(host, port) the browser used, from the Host header."""
    raw = (request.headers.get("host") or "").strip().lower()
    if raw.startswith("["):
        host, _, rest = raw[1:].partition("]")
        return host, rest[1:] if rest.startswith(":") else None
    host, _, port = raw.partition(":")
    return host, port or None


def vip_url(request, vip: str) -> str:
    """The same page on the virtual IP, keeping the scheme and port the request came in on."""
    _host, port = request_host(request)
    scheme = request.url.scheme if request.url.scheme in ("http", "https") else "http"
    port = port if port and port.isdigit() else None
    return f"{scheme}://{vip}{':' + port if port else ''}/"


def splash_kind(m: "HAManager", request) -> str | None:
    """"standby" or "fault" when this request should get the splash page instead of the app."""
    if not m.cfg or m.state not in (STANDBY, FAULT):
        return None
    if request.query_params.get("stay") == "1" or request.cookies.get("haven_stay") == "1":
        return None
    if request_host(request)[0] == m.cfg.vip:
        return None
    if m.state == FAULT and m.want_services():
        return None          # this node is the one serving (single instance): don't send people away
    return m.state


def _esc(v) -> str:
    import html
    return html.escape(str(v), quote=True)


def splash_html(kind: str, url: str, vip: str, seconds: int = 5) -> str:
    standby = kind == STANDBY
    title = "This is the standby Haven" if standby else "This Haven is in a fault state"
    lead = (f"The active Haven is at <b>{_esc(vip)}</b>. Taking you there in "
            f"<b id=\"count\">{seconds}</b>&nbsp;s…" if standby else
            f"High availability can't run here right now. The active Haven should be at <b>{_esc(vip)}</b>.")
    refresh = f'<meta http-equiv="refresh" content="{seconds};url={_esc(url)}">' if standby else ""
    logo = _logo_path()
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Haven · {"Standby" if standby else "Fault"}</title>{refresh}
<style>
:root {{ color-scheme: light dark; --bg:#f8f9ff; --fg:#191c20; --mut:#43474e; --pri:#39608f; --onpri:#fff; --card:#ecedf4;
  --logo:#d3e4ff; --onlogo:#1d4875; --bad:#ffdad6; --onbad:#93000a; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#111418; --fg:#e1e2e8; --mut:#c3c6cf; --pri:#a3c9fe; --onpri:#00315b;
  --card:#1d2024; --logo:#1d4875; --onlogo:#d3e4ff; --bad:#93000a; --onbad:#ffdad6; }} }}
* {{ box-sizing: border-box; }}
body {{ margin:0; min-height:100vh; min-height:100dvh; display:grid; place-items:center; padding:24px 16px;
  background:var(--bg); color:var(--fg); font:16px/24px Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ width:100%; max-width:440px; background:var(--card); border-radius:28px; padding:32px 24px; text-align:center; }}
.logo {{ width:72px; height:72px; border-radius:20px; margin:0 auto 20px; display:grid; place-items:center;
  background:{"var(--logo)" if standby else "var(--bad)"}; color:{"var(--onlogo)" if standby else "var(--onbad)"}; }}
.logo svg {{ width:56px; height:56px; }}
.logo {{ --logo-bg:{"var(--logo)" if standby else "var(--bad)"}; }}
h1 {{ margin:0 0 8px; font-size:24px; line-height:32px; font-weight:400; }}
p {{ margin:0 0 24px; color:var(--mut); overflow-wrap:anywhere; }}
p b {{ color:var(--fg); font-weight:500; }}
.go {{ display:inline-flex; align-items:center; justify-content:center; height:48px; padding:0 28px; border-radius:24px;
  background:var(--pri); color:var(--onpri); text-decoration:none; font-weight:500; letter-spacing:.1px; min-width:160px; }}
.stay {{ display:inline-block; margin-top:20px; color:var(--pri); font-size:14px; text-decoration:none; padding:8px; }}
.go:focus-visible, .stay:focus-visible {{ outline:2px solid var(--pri); outline-offset:3px; }}
</style></head>
<body><main data-seconds="{seconds if standby else 0}" data-url="{_esc(url)}">
<div class="logo">{logo}</div>
<h1>{title}</h1>
<p>{lead}</p>
<a class="go" id="go" href="{_esc(url)}">{"Go now" if standby else "Open " + _esc(vip)}</a><br>
<a class="stay" href="/?stay=1">Stay on this Haven{" (admin)" if standby else ""}</a>
</main><script src="/static/ha-splash.js"></script></body></html>"""


def splash_response(request, m: "HAManager | None" = None):
    m = m or ha
    kind = splash_kind(m, request)
    if not kind:
        return None
    from fastapi.responses import HTMLResponse
    return HTMLResponse(splash_html(kind, vip_url(request, m.cfg.vip), m.cfg.vip),
                        headers={"Cache-Control": "no-store"})


def guess_self_address(peer_url: str) -> str:
    """This Haven's own address as the other NAS would reach it: the local IP on the route to it."""
    from urllib.parse import urlsplit
    u = urlsplit(peer_url)
    host = (u.hostname or "").strip("[]")
    ip = None
    try:
        fam = socket.AF_INET6 if ":" in host else socket.AF_INET
        with socket.socket(fam, socket.SOCK_DGRAM) as s:
            s.connect((host, 9))                  # UDP "connect" sends nothing; it just picks the route
            ip = s.getsockname()[0]
    except OSError:
        pass
    ip = ip or socket.gethostname()
    if u.scheme == "https" and int(os.environ.get("HAVEN_HTTPS_PORT", HTTPS_PORT) or 0):
        return f"https://{url_host(ip)}:{os.environ.get('HAVEN_HTTPS_PORT', HTTPS_PORT)}"
    return f"{url_host(ip)}:{os.environ.get('HAVEN_PORT', HTTP_PORT)}"


def url_host(h: str) -> str:
    return f"[{h}]" if ":" in h else h


def same_peer(a: str, b: str) -> bool:
    try:
        return parse_peer(a) == parse_peer(b)
    except ValueError:
        return False


# ---------------------------------------------------------------- HTTP API
class _Early(Exception):
    def __init__(self, resp) -> None:
        self.resp = resp


class FailoverIn(BaseModel):
    action: str = "auto"      # auto | handover | takeover



class AdoptIn(BaseModel):
    peer: str                       # the primary's own address, as this backup reaches it
    secret: str
    vip: str
    prefix: int = 24
    priority: int = 100
    force: bool = False             # replace an existing pairing with another Haven
    primary: str = ""               # label for the events list


class AdoptBackupIn(BaseModel):
    backup: str                     # the backup's own address
    username: str = "admin"
    password: str = ""
    my_address: str = ""            # this primary as the backup reaches it (empty: guessed)
    vip: str = ""
    prefix: int | None = None
    force: bool = False


def _ha_section() -> dict:
    from . import settings as settings_mod
    return settings_mod.effective_config().get("ha") or {}


def _write_ha(values: dict) -> None:
    from . import settings as settings_mod
    settings_mod.save_section("ha", True, values)


async def _save_ha(m: "HAManager", values: dict) -> None:
    try:
        m.write_section(values)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"invalid value: {e}") from e
    if m.on_settings_saved:
        m.on_settings_saved()
    await m.configure(m.read_section())


async def adopt_as_standby(m: "HAManager", body: AdoptIn) -> Any:
    cur = m.read_section()
    try:
        parse_peer(body.peer)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if cur.get("enabled") and cur.get("peer") and not same_peer(str(cur.get("peer")), body.peer) and not body.force:
        return JSONResponse({"detail": f"This Haven is already paired with {cur.get('peer')}. Replace that pairing?",
                             "needs_confirm": True, "current_peer": str(cur.get("peer"))}, status_code=409)
    await _save_ha(m, {"role": "standby", "peer": body.peer.strip(), "secret": body.secret, "vip": body.vip.strip(),
                       "prefix": body.prefix, "priority": body.priority, "interface": "", "preempt": True, "sync": True})
    m.note(f"paired as standby by {body.primary or body.peer}")
    return {"ok": True, "status": m.status()}


async def adopt_backup(m: "HAManager", body: AdoptBackupIn) -> Any:
    import httpx
    cur = m.read_section()
    try:
        backup_url = parse_peer(body.backup)
    except ValueError as e:
        raise HTTPException(400, str(e).replace("Other Haven's address", "Backup address")) from e
    vip = (body.vip or cur.get("vip") or "").strip()
    if not vip:
        raise HTTPException(400, "Enter the virtual IP address both Havens will share")
    prefix = body.prefix or cur.get("prefix") or 24
    my_address = (body.my_address or "").strip() or guess_self_address(backup_url)
    try:
        if parse_peer(my_address) == backup_url:
            raise HTTPException(400, "The backup's address is this Haven's own address: enter the other NAS's IP")
    except ValueError as e:
        raise HTTPException(400, str(e).replace("Other Haven's address", "This Haven's address")) from e
    secret = str(cur.get("secret") or "")
    generated = len(secret) < MIN_SECRET
    if generated:
        secret = secrets.token_urlsafe(24)
    payload = {"peer": my_address, "secret": secret, "vip": vip, "prefix": prefix, "priority": 100,
               "force": body.force, "primary": my_address}
    # check the whole configuration before touching the backup
    try:
        HAConfig({"enabled": True, "role": "primary", "peer": body.backup, "secret": secret, "vip": vip, "prefix": prefix})
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    async with httpx.AsyncClient(verify=False, trust_env=False, follow_redirects=False, timeout=10) as c:  # noqa: S501 - see the comment below
        # verify=False: a backup on https:// usually has Haven's self-signed certificate (documented)
        try:
            r = await c.post(backup_url + "/api/auth/login", json={"username": body.username, "password": body.password})
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Can't reach the backup at {body.backup}: {type(e).__name__}. Check the address, "
                                     "that Haven runs there, and port 1701.") from e
        if r.status_code == 401:
            raise HTTPException(400, "The backup rejected that username or password")
        if r.status_code == 404:
            raise HTTPException(502, "That address doesn't answer like a Haven (or it runs an old version without accounts)")
        if r.status_code != 200:
            raise HTTPException(502, f"The backup refused the sign-in: {_detail(r)}")
        tok = r.json().get("token", "")
        h = {"authorization": f"Bearer {tok}"}
        try:
            r = await c.post(backup_url + "/api/ha/adopt", json=payload, headers=h)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"The backup stopped answering: {type(e).__name__}") from e
        finally:
            try:
                await c.post(backup_url + "/api/auth/logout", headers=h)
            except httpx.HTTPError:
                pass
    if r.status_code == 409:
        return JSONResponse(r.json(), status_code=409)
    if r.status_code == 403:
        raise HTTPException(400, "That account isn't an admin on the backup")
    if r.status_code == 404:
        raise HTTPException(502, "The backup's Haven is too old for automatic pairing: update it, or pair manually")
    if r.status_code != 200:
        raise HTTPException(502, f"The backup couldn't be set up: {_detail(r)}")
    backup_status = (r.json() or {}).get("status") or {}
    # this Haven becomes (or stays) the primary of that backup
    await _save_ha(m, {"role": "primary", "peer": body.backup.strip(), "secret": secret, "vip": vip, "prefix": prefix})
    m.note(f"paired {body.backup.strip()} as its standby")
    return {"ok": True, "secret_generated": generated, "my_address": my_address,
            "backup_state": backup_status.get("state"),
            "backup_fault": (backup_status.get("message") or None) if backup_status.get("state") == FAULT else None,
            "status": m.status()}


def _detail(r) -> str:
    try:
        d = r.json().get("detail")
        return d if isinstance(d, str) else str(d)[:200]
    except Exception:  # noqa: BLE001
        return f"HTTP {r.status_code}"


def build_router(get: Callable[[], HAManager]) -> APIRouter:
    """/api/ha/* for the manager returned by get() (the module's `ha`, or a test's own)."""
    r = APIRouter()
    from .security import AuthLimiter
    limiter = AuthLimiter(free=20)

    async def peer_auth(request: Request) -> tuple[HAManager, bytes, str]:
        """Shared-secret check for /api/ha/peer/*: these never use a user session."""
        m = get()
        if not m.cfg:
            raise _Early(JSONResponse({"detail": "High availability is off on this Haven", "reason": "ha_off"},
                                      status_code=409))
        ip = request.client.host if request.client else "?"
        if limiter.retry_after(ip):
            raise _Early(JSONResponse({"detail": "too many bad requests", "reason": "signature"}, status_code=403))
        body = await request.body()
        ok, reason, nonce = m.authenticate(request.method, request.url.path, body, request.headers.get(AUTH_HEADER))
        if not ok:
            limiter.failed(ip)
            raise _Early(JSONResponse({"detail": "forbidden", "reason": reason}, status_code=403))
        limiter.ok(ip)
        return m, body, nonce

    @r.post("/api/ha/peer/heartbeat")
    async def peer_heartbeat(request: Request):
        try:
            m, body, nonce = await peer_auth(request)
        except _Early as e:
            return e.resp
        try:
            info = json.loads(body or b"{}")
        except ValueError:
            raise HTTPException(400, "bad heartbeat") from None
        return m.signed(await m.on_heartbeat(info if isinstance(info, dict) else {}), nonce)

    @r.get("/api/ha/peer/config")
    async def peer_config(request: Request):
        try:
            m, _body, nonce = await peer_auth(request)
        except _Early as e:
            return e.resp
        return m.signed(m.config_payload(nonce), nonce)

    @r.post("/api/ha/peer/yield")
    async def peer_yield(request: Request):
        try:
            m, _body, nonce = await peer_auth(request)
        except _Early as e:
            return e.resp
        return m.signed(await m.on_yield_request(), nonce)

    @r.get("/api/ha/status")
    async def ha_status():
        return get().status()

    @r.post("/api/ha/failover")
    async def ha_failover(body: FailoverIn | None = None):
        return await get().failover((body or FailoverIn()).action)


    @r.get("/api/ha/where")
    async def ha_where(request: Request):
        """Public: where the active Haven is (only the virtual IP and this node's state)."""
        m = get()
        if not m.cfg:
            return {"state": DISABLED, "active_url": None}
        return {"state": m.state, "active_url": vip_url(request, m.cfg.vip)}

    @r.post("/api/ha/adopt")
    async def ha_adopt(body: AdoptIn):
        """On the backup (admin, also with the default password): become the standby of the caller."""
        return await adopt_as_standby(get(), body)

    @r.get("/api/ha/adopt_defaults")
    async def ha_adopt_defaults(backup: str = ""):
        m = get()
        cur = m.read_section()
        try:
            me = guess_self_address(parse_peer(backup)) if backup.strip() else ""
        except ValueError:
            me = ""
        return {"my_address": me, "vip": cur.get("vip") or "", "prefix": cur.get("prefix") or 24,
                "username": "admin", "password_hint": "haven-admin", "configured": bool(m.cfg)}

    @r.post("/api/ha/adopt_backup")
    async def ha_adopt_backup(body: AdoptBackupIn):
        """On the primary (admin): sign in to a backup Haven and make it this Haven's standby."""
        return await adopt_backup(get(), body)

    return r


router = build_router(lambda: ha)
