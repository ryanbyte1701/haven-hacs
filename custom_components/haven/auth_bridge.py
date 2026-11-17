"""Home Assistant's sign-in in place of Haven's own accounts (core/auth.py's `store`).

Haven's middleware asks `auth.store.resolve(token)` who a Bearer token belongs to; in the HACS edition that
store is this one, and the tokens are Home Assistant access tokens (the panel passes the signed-in user's).

- Home Assistant administrators are Haven admins; every other active Home Assistant user is a Regular user
  (sees and controls devices). There are no Haven passwords, guests or view-only accounts.
- Live updates (/ws) get a short ticket instead of the access token (Home Assistant's tokens expire after
  30 minutes; the ticket lives as long as the sign-in it came from, so an open dashboard isn't disconnected).
- Haven runs in its own thread (bridge.py). The bridge checks each request's token in Home Assistant's loop
  first (prepare_request) and Haven's middleware then finds the answer here, so Home Assistant's auth objects are
  used from Home Assistant's own loop.

Duck-typed against Home Assistant's AuthManager (async_validate_access_token, async_get_refresh_token):
no Home Assistant import, so it is tested with a fake.
"""
from __future__ import annotations

import hashlib
import secrets
import time
from collections import OrderedDict

MAX_TICKETS = 500
MAX_CHECKED = 500
CHECKED_FOR = 60.0        # seconds a checked token's answer is kept (Haven sees it a moment later)


def _key(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class HassAuthStore:
    """The parts of core/auth.py's AuthStore that the rest of Haven uses."""

    def __init__(self, hass) -> None:
        self.hass = hass
        self.users: dict = {}               # Haven has no accounts of its own here
        self.sessions: dict = {}
        self.guest_view = False
        self._tickets: OrderedDict[str, str] = OrderedDict()     # sha256(ticket) -> refresh token id
        self._checked: OrderedDict[str, tuple[float, dict | None]] = OrderedDict()   # sha256(token) -> (until, who)

    def prepare_request(self, request) -> None:
        """In Home Assistant's loop, before the bridge hands a request to Haven: check its Bearer token."""
        token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if token:
            rt = self._refresh_token(token)
            self._checked[_key(token)] = (time.monotonic() + CHECKED_FOR, self.principal(rt.user) if rt else None)
            while len(self._checked) > MAX_CHECKED:
                self._checked.popitem(last=False)

    # ---------------- who is this ----------------
    @staticmethod
    def principal(user) -> dict:
        name = (getattr(user, "name", None) or "Home Assistant user")[:64]
        return {"user": name, "role": "admin" if user.is_admin else "user", "guest": False, "must_change": False}

    def _refresh_token(self, token: str | None):
        if not token or len(token) > 4096:
            return None
        if token.startswith("hvt_"):                                   # a live-updates ticket
            rid = self._tickets.get(_key(token))
            rt = self.hass.auth.async_get_refresh_token(rid) if rid else None
        else:
            rt = self.hass.auth.async_validate_access_token(token)
        if rt is None or not getattr(rt.user, "is_active", False) or getattr(rt.user, "system_generated", False):
            return None
        return rt

    def resolve(self, token: str | None) -> dict | None:
        if token:
            hit = self._checked.get(_key(token))
            if hit is not None and hit[0] > time.monotonic():
                return dict(hit[1]) if hit[1] else None
        rt = self._refresh_token(token)
        return self.principal(rt.user) if rt else None

    def still_valid(self, token: str | None) -> bool:
        return self._refresh_token(token) is not None

    def ws_ticket(self, access_token: str) -> str | None:
        """A Home Assistant access token -> a ticket for Haven's /ws (None if the token isn't valid)."""
        if access_token.startswith("hvt_"):
            return None
        rt = self._refresh_token(access_token)
        if rt is None:
            return None
        ticket = "hvt_" + secrets.token_urlsafe(24)
        self._tickets[_key(ticket)] = rt.id
        while len(self._tickets) > MAX_TICKETS:
            self._tickets.popitem(last=False)
        return ticket

    # ---------------- what Haven's own accounts would do: nothing here ----------------
    @property
    def default_password_in_use(self) -> bool:
        return False

    def has_users(self) -> bool:
        return True

    def admins(self) -> list[str]:
        return []

    def list_users(self) -> list[dict]:
        return []

    def bootstrap_default(self, user=None, password=None) -> bool:
        return False

    def reload_users(self) -> None:
        pass

    def revoke(self, token) -> None:
        if token:
            self._tickets.pop(_key(token), None)

    def revoke_user(self, name) -> None:
        pass

    def revoke_guests(self) -> None:
        pass

    def new_session(self, *a, **k):
        raise PermissionError("Haven for Home Assistant uses Home Assistant's accounts")

    def verify(self, *a, **k):
        return None
