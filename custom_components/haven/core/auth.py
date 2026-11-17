"""User accounts, roles and sign-in sessions.

Roles
- admin:   everything (settings, integrations, automations, users, layout)
- user:    sees everything a monitor sees and can control devices (POST /api/devices/{id}/command)
- monitor: observation only (no camera snapshots). Also the role of the built-in "viewer" guest session
           (POST /api/auth/guest, LAN addresses only, when "Allow viewing without signing in" is on;
           off by default: an admin turns it on under Users & access).

First start
- User HAVEN_ADMIN_USER (default "admin") with HAVEN_ADMIN_PASSWORD (default "haven-admin"),
  marked must_change: until that account picks its own password, its sessions can only reach
  MUST_CHANGE_OK (change password, sign out, and the HA adopt call a primary makes with the defaults).

Storage (DATA_DIR, both files 0600 via write_private)
- users.json:    {"users": {name: {role, hash, salt, created, must_change?}}, "guest_view": false}
                 hash = scrypt(password, salt, n=2**14, r=8, p=1), hex
- sessions.json: {sha256(token): {user, role, guest, created, last_seen}}; the token itself is never stored

The single route policy for the HTTP API lives in allowed() below; main.py's middleware applies it.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import time
from contextlib import contextmanager
from pathlib import Path

from .config import DATA_DIR, conf_dir, write_private

log = logging.getLogger("haven.auth")

ROLES = ("admin", "user", "monitor")
ROLE_LABEL = {"admin": "Admin", "user": "Regular", "monitor": "Monitor"}
NAME_RE = re.compile(r"[a-z0-9._-]{1,32}")
MIN_PASSWORD = 10
IDLE_EXPIRY = 30 * 86400            # sessions end after 30 days without use
TOUCH_EVERY = 3600                  # persist last_seen at most hourly per session
MAX_SESSIONS = 2000
MAX_GUEST_SESSIONS = 300
GUEST_USER = "viewer"
DEFAULT_ADMIN_USER, DEFAULT_ADMIN_PASSWORD = "admin", "haven-admin"
SCRYPT = dict(n=2 ** 14, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)


def hash_password(password: str, salt: bytes) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, **SCRYPT).hex()


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_name(name: str) -> str:
    name = (name or "").strip().lower()
    if not NAME_RE.fullmatch(name):
        raise ValueError("Usernames are 1–32 characters: lowercase letters, digits, dot, dash or underscore")
    if name == GUEST_USER:
        raise ValueError(f"'{GUEST_USER}' is reserved for people viewing without signing in")
    return name


def check_password(pw: str) -> str:
    if not isinstance(pw, str) or len(pw) < MIN_PASSWORD:
        raise ValueError(f"Passwords need at least {MIN_PASSWORD} characters")
    if len(pw) > 1024:
        raise ValueError("That password is too long")
    return pw


def check_role(role: str) -> str:
    if role not in ROLES:
        raise ValueError(f"Role must be one of: {', '.join(ROLES)}")
    return role


def is_private_ip(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if getattr(a, "ipv4_mapped", None):
        a = a.ipv4_mapped
    return a.is_private or a.is_loopback or a.is_link_local


class AuthStore:
    def __init__(self, data_dir: Path | str | None = None) -> None:
        self.dir = Path(data_dir or DATA_DIR)
        self.users_file = (self.dir if data_dir else conf_dir()) / "users.json"   # accounts: config folder
        self.sessions_file = self.dir / "sessions.json"
        self.users: dict[str, dict] = {}
        self.guest_view = False         # off until an admin turns it on
        self.sessions: dict[str, dict] = {}
        self._dummy: tuple[bytes, str] | None = None
        self._load()

    # ------------------------------------------------------------ persistence
    def _load(self) -> None:
        try:
            raw = json.loads(self.users_file.read_text())
            self.users = {k: v for k, v in (raw.get("users") or {}).items()
                          if isinstance(v, dict) and v.get("role") in ROLES and v.get("hash") and v.get("salt")}
            self.guest_view = bool(raw.get("guest_view", False))
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError) as e:
            log.error("Could not read %s (%s): starting without accounts", self.users_file, e)
        try:
            raw = json.loads(self.sessions_file.read_text())
            now = time.time()
            self.sessions = {k: v for k, v in raw.items() if isinstance(v, dict) and now - v.get("last_seen", 0) < IDLE_EXPIRY}
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError) as e:
            log.warning("Could not read %s (%s): everyone signs in again", self.sessions_file, e)

    def _save_users(self) -> None:
        write_private(self.users_file, json.dumps({"users": self.users, "guest_view": self.guest_view}, indent=1))

    @contextmanager
    def _changing(self):
        """Change accounts in memory, then save. If anything fails (a ValueError, or an OSError because the
        config folder can't be written), memory goes back to what is on disk and the error is raised, so a
        password is never "changed" until the next restart only."""
        snap = (copy.deepcopy(self.users), self.guest_view)
        try:
            yield
            self._save_users()
        except BaseException:
            self.users, self.guest_view = snap
            raise

    def _save_sessions(self) -> None:
        try:
            write_private(self.sessions_file, json.dumps(self.sessions))
        except OSError as e:
            log.warning("Could not save sessions (%s): sign-ins last until the next restart", e)

    # ------------------------------------------------------------ users
    @property
    def has_users(self) -> bool:
        return bool(self.users)

    def admins(self) -> list[str]:
        return [n for n, u in self.users.items() if u["role"] == "admin"]

    def list_users(self) -> list[dict]:
        return [{"name": n, "role": u["role"], "created": u.get("created"), "must_change": bool(u.get("must_change"))}
                for n, u in sorted(self.users.items())]

    @property
    def default_password_in_use(self) -> bool:
        return any(u.get("must_change") for u in self.users.values())

    def reload_users(self) -> None:
        """users.json was replaced (HA settings copy): re-read it and sign out everyone whose account
        disappeared or whose password/role changed (e.g. the backup's default admin)."""
        old = {n: (u.get("hash"), u.get("role")) for n, u in self.users.items()}
        self._load_users_only()
        stale = {n for n, v in old.items() if (self.users.get(n, {}).get("hash"), self.users.get(n, {}).get("role")) != v}
        if stale:
            self.sessions = {k: v for k, v in self.sessions.items() if v.get("guest") or v.get("user") not in stale}
            self._save_sessions()
        if not self.guest_view:
            self.revoke_guests()

    def _load_users_only(self) -> None:
        try:
            raw = json.loads(self.users_file.read_text())
            self.users = {k: v for k, v in (raw.get("users") or {}).items()
                          if isinstance(v, dict) and v.get("role") in ROLES and v.get("hash") and v.get("salt")}
            self.guest_view = bool(raw.get("guest_view", False))
        except (OSError, ValueError, AttributeError) as e:
            log.error("Could not read %s (%s)", self.users_file, e)

    def create_user(self, name: str, password: str, role: str) -> dict:
        name, role = check_name(name), check_role(role)
        check_password(password)
        if name in self.users:
            raise ValueError("A user with that name already exists")
        if len(self.users) >= 200:
            raise ValueError("Too many users")
        salt = secrets.token_bytes(16)
        with self._changing():
            self.users[name] = {"role": role, "hash": hash_password(password, salt), "salt": salt.hex(), "created": time.time()}
        log.info("user %s created (%s)", name, role)
        return {"name": name, "role": role, "created": self.users[name]["created"]}

    def verify(self, name: str, password: str) -> str | None:
        """Role on success, None otherwise. Takes the same time for unknown users."""
        name = (name or "").strip().lower()
        u = self.users.get(name)
        if u is None:
            if self._dummy is None:
                salt = secrets.token_bytes(16)
                self._dummy = (salt, hash_password(secrets.token_hex(8), salt))
            hash_password(password or "", self._dummy[0])
            return None
        got = hash_password(password or "", bytes.fromhex(u["salt"]))
        return u["role"] if hmac.compare_digest(got, u["hash"]) else None

    def _check_demote(self, name: str, role: str | None) -> None:
        if role is not None and role != "admin" and self.users[name]["role"] == "admin" and self.admins() == [name]:
            raise ValueError("This is the last admin. Make someone else an admin first.")

    def update_user(self, name: str, *, password: str | None = None, role: str | None = None,
                    new_name: str | None = None) -> str:
        """Change a user's password, role and/or name in one save: everything is checked first and nothing
        changes unless all of it is valid and saved. Signs the user out everywhere. Returns the (new) name."""
        if name not in self.users:
            raise KeyError(name)
        if password is not None:
            check_password(password)
        if role is not None:
            check_role(role)
            self._check_demote(name, role)
        target = name
        if new_name is not None and new_name.strip().lower() != name:
            target = check_name(new_name)
            if target in self.users:
                raise ValueError("A user with that name already exists")
        u = self.users[name]
        if password is None and target == name and (role is None or role == u["role"]):
            return name                                   # nothing to do
        salt = secrets.token_bytes(16) if password is not None else None
        digest = hash_password(password, salt) if password is not None else None
        with self._changing():
            u = self.users.pop(name) if target != name else self.users[name]
            self.users[target] = u
            if password is not None:
                u.update(hash=digest, salt=salt.hex())
                u.pop("must_change", None)
            if role is not None:
                u["role"] = role
        self.revoke_user(name)
        if target != name:
            log.info("user %s renamed to %s", name, target)
        return target

    def set_password(self, name: str, password: str) -> None:
        self.update_user(name, password=password)

    def rename_user(self, old: str, new: str) -> str:
        return self.update_user(old, new_name=new)

    def set_role(self, name: str, role: str) -> None:
        self.update_user(name, role=role)

    def delete_user(self, name: str) -> None:
        if name not in self.users:
            raise KeyError(name)
        if self.users[name]["role"] == "admin" and self.admins() == [name]:
            raise ValueError("You can't delete the last admin.")
        with self._changing():
            del self.users[name]
        self.revoke_user(name)

    def set_guest_view(self, on: bool) -> None:
        with self._changing():
            self.guest_view = bool(on)
        if not on:
            self.revoke_guests()

    def bootstrap_default(self, user: str | None = None, password: str | None = None) -> bool:
        """First start (no users yet): the admin account from HAVEN_ADMIN_USER / HAVEN_ADMIN_PASSWORD
        (defaults admin / haven-admin). It must pick its own password at the first sign-in."""
        if self.users:
            return False
        try:
            name = check_name(user or DEFAULT_ADMIN_USER)
        except ValueError as e:
            log.error("HAVEN_ADMIN_USER is not a valid username (%s): using %r", e, DEFAULT_ADMIN_USER)
            name = DEFAULT_ADMIN_USER
        password = password or DEFAULT_ADMIN_PASSWORD
        salt = secrets.token_bytes(16)
        self.users[name] = {"role": "admin", "hash": hash_password(password, salt), "salt": salt.hex(),
                            "created": time.time(), "must_change": True}
        self.guest_view = False        # nobody sees anything until an admin has signed in and decided
        try:
            self._save_users()
        except OSError as e:
            log.error("Could not save %s (%s)", self.users_file, e)
        return True

    # ------------------------------------------------------------ sessions
    def new_session(self, user: str, role: str, guest: bool = False) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        self._prune(now)
        if guest:
            guests = sorted((v["last_seen"], k) for k, v in self.sessions.items() if v.get("guest"))
            for _, k in guests[:max(0, len(guests) - MAX_GUEST_SESSIONS + 1)]:
                self.sessions.pop(k, None)
        if len(self.sessions) >= MAX_SESSIONS:
            for _, k in sorted((v["last_seen"], k) for k, v in self.sessions.items())[:len(self.sessions) - MAX_SESSIONS + 1]:
                self.sessions.pop(k, None)
        self.sessions[_digest(token)] = {"user": user, "role": role, "guest": guest, "created": now, "last_seen": now}
        self._save_sessions()
        return token

    def resolve(self, token: str | None) -> dict | None:
        """{user, role, guest} for a valid session token, else None. Roles come from the live user record."""
        if not token or len(token) > 200:
            return None
        key = _digest(token)
        s = self.sessions.get(key)
        if s is None:
            return None
        now = time.time()
        if now - s.get("last_seen", 0) > IDLE_EXPIRY:
            self.sessions.pop(key, None)
            self._save_sessions()
            return None
        if s.get("guest"):
            if not self.guest_view:
                return None
            role = "monitor"
        else:
            u = self.users.get(s["user"])
            if u is None:
                self.sessions.pop(key, None)
                self._save_sessions()
                return None
            role = u["role"]
        if now - s.get("last_seen", 0) > TOUCH_EVERY:
            s["last_seen"] = now
            self._save_sessions()
        u = self.users.get(s["user"]) if not s.get("guest") else None
        return {"user": s["user"], "role": role, "guest": bool(s.get("guest")), "must_change": bool(u and u.get("must_change"))}

    def still_valid(self, token: str | None) -> bool:
        """Cheap re-check for long-lived connections (the live-updates WebSocket): False once the session
        was signed out or revoked (password or role change, user deleted, viewing turned off)."""
        s = self.sessions.get(_digest(token)) if token else None
        if s is None:
            return False
        if s.get("guest"):
            return self.guest_view
        u = self.users.get(s.get("user"))
        return bool(u) and not u.get("must_change")

    def revoke(self, token: str | None) -> None:
        if token and self.sessions.pop(_digest(token), None) is not None:
            self._save_sessions()

    def revoke_user(self, name: str) -> None:
        before = len(self.sessions)
        self.sessions = {k: v for k, v in self.sessions.items() if v.get("guest") or v.get("user") != name}
        if len(self.sessions) != before:
            self._save_sessions()

    def revoke_guests(self) -> None:
        before = len(self.sessions)
        self.sessions = {k: v for k, v in self.sessions.items() if not v.get("guest")}
        if len(self.sessions) != before:
            self._save_sessions()

    def _prune(self, now: float) -> None:
        self.sessions = {k: v for k, v in self.sessions.items() if now - v.get("last_seen", 0) < IDLE_EXPIRY}


store = AuthStore()


def reset(data_dir: Path | str | None = None) -> AuthStore:
    """Re-read state from disk (tests; a restart)."""
    global store
    store = AuthStore(data_dir)
    return store


# ------------------------------------------------------------ route policy
PUBLIC_API = {"/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/guest", "/api/ha/where"}
PUBLIC_PREFIX = ("/api/ha/peer/",)          # HA peers authenticate with their own shared secret (app/ha.py)
SELF_SERVICE = {("POST", "/api/auth/logout"), ("GET", "/api/me"), ("POST", "/api/me/password")}
# config & secrets: never for monitors (and not for regular users, who can't change settings either)
CONFIG_PATHS = ("/api/settings", "/api/automations", "/api/users", "/api/ha", "/api/ecowitt", "/api/aqara", "/api/diagnostics",
                "/api/hue", "/api/auth/guest_view")
READ_OK = {"/api/ha/status"}
USER_READ = ("/api/automations",)          # regular users may look at automations (not change them)
NOT_FOR_MONITOR = ("/api/ring",)           # camera snapshots are sensitive: admins and regular users only
_COMMAND = re.compile(r"/api/devices/[^/]+/command")
# A must_change account (default password) reaches only these until it has chosen its own password.
# /api/ha/adopt: a primary pairs a freshly installed backup using its default admin (app/ha.py).
MUST_CHANGE_OK = {("GET", "/api/me"), ("POST", "/api/me/password"), ("POST", "/api/auth/logout"),
                  ("POST", "/api/ha/adopt")}


def must_change_allows(method: str, path: str) -> bool:
    return (method, path) in MUST_CHANGE_OK


def _under(path: str, prefixes) -> bool:
    return any(path == p or path.startswith(p + "/") for p in prefixes)


def is_public(path: str) -> bool:
    return path in PUBLIC_API or path.startswith(PUBLIC_PREFIX)


def allowed(role: str, method: str, path: str) -> bool:
    if role == "admin":
        return True
    if (method, path) in SELF_SERVICE:
        return True
    if method in ("GET", "HEAD"):
        if path in READ_OK:
            return True
        if role == "user" and _under(path, USER_READ):
            return True
        if role == "monitor" and _under(path, NOT_FOR_MONITOR):
            return False
        return not _under(path, CONFIG_PATHS)
    return role == "user" and method == "POST" and bool(_COMMAND.fullmatch(path))
