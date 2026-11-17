"""HTTP endpoints for sign-in, the signed-in user's account and (admins) user management.

Who may call what is decided by the middleware in main.py using auth.allowed(); the endpoints here
only add the checks that depend on the request body or on the caller being a real (non-guest) user.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import auth
from . import security as sec

router = APIRouter()
guest_limiter = sec.RateLimiter(rate=0.2, burst=10)       # viewer sessions per address
_sems: dict = {}


def _hashing() -> asyncio.Semaphore:
    """scrypt is CPU-heavy: at most two at a time (one semaphore per event loop)."""
    loop = asyncio.get_running_loop()
    return _sems.setdefault(id(loop), asyncio.Semaphore(2))


def _m():
    from . import main      # late import: main includes this router
    return main


def _pw_key(ip: str) -> str:
    """Wrong passwords are counted per address under their own key: a valid session (a viewer's, or the
    attacker's own account) resets the middleware's per-address count of wrong tokens, never this one."""
    return "pw:" + ip


def _principal(request: Request) -> dict:
    p = getattr(request.state, "principal", None)
    if not p:
        raise HTTPException(401, "unauthorized")
    return p


def _session(user: str, role: str, guest: bool = False) -> dict:
    return {"token": auth.store.new_session(user, role, guest), "user": user, "role": role, "guest": guest}


class Credentials(BaseModel):
    username: str = ""
    password: str = ""


class PasswordChange(BaseModel):
    current: str = ""
    new: str = ""
    username: str | None = None   # optional new username (the forced first change offers it)


class NewUser(BaseModel):
    name: str = ""
    username: str = ""          # same as name (the sign-in form calls it username)
    password: str = ""
    role: str = "user"


class UserPatch(BaseModel):
    role: str | None = None
    password: str | None = None


class Toggle(BaseModel):
    enabled: bool


# ---------------- public ----------------
@router.get("/api/auth/state")
async def auth_state(request: Request):
    lan = auth.is_private_ip(_m()._client_ip(request))
    # default_login: a fresh install's admin still has the documented default password (LAN only, for the hint)
    return {"guest_view": auth.store.guest_view and lan, "default_login": auth.store.default_password_in_use and lan}


@router.post("/api/auth/login")
async def auth_login(body: Credentials, request: Request):
    m = _m()
    ip = m._client_ip(request)
    key = _pw_key(ip)
    if m.auth_limiter.flooding(key):         # only while many wrong guesses from here are waiting at once
        return JSONResponse({"detail": "Too many wrong passwords from this device. Wait a few seconds and try again."},
                            status_code=429, headers={"Retry-After": "5"})
    name = (body.username or "").strip().lower()[:64]
    async with _hashing():
        role = await asyncio.to_thread(auth.store.verify, name, body.password[:1024])
    if not role:
        await m.auth_limiter.punish(key)      # checked first, so the right password is never locked out
        raise HTTPException(401, "Wrong username or password")
    # (no auth_limiter.ok(key) here: signing in to one's own account must not reset the count of wrong
    # guesses at someone else's password; it fades 10 minutes after the last wrong one)
    if auth.store.users[name].get("must_change") and not auth.is_private_ip(ip):
        raise HTTPException(403, "This account still has the default password. Sign in from your home network "
                                 "and choose your own password first.")
    return _session(name, role)


@router.post("/api/auth/guest")
async def auth_guest(request: Request):
    ip = _m()._client_ip(request)
    if not auth.store.guest_view:
        raise HTTPException(403, "Viewing without signing in is turned off. Sign in instead.")
    if not auth.is_private_ip(ip):
        raise HTTPException(403, "Viewing without signing in only works on your home network. Sign in instead.")
    if not guest_limiter.allow(ip):
        raise HTTPException(429, "Too many viewer sign-ins from this device. Wait a minute and try again.")
    return _session(auth.GUEST_USER, "monitor", guest=True)


# ---------------- signed in ----------------
@router.post("/api/auth/logout")
async def auth_logout(request: Request):
    auth.store.revoke(_m()._request_token(request))
    return {"ok": True}


@router.get("/api/me")
async def me(request: Request):
    p = _principal(request)
    return {"user": p["user"], "role": p["role"], "role_label": auth.ROLE_LABEL[p["role"]], "guest": p["guest"],
            "must_change": bool(p.get("must_change"))}


@router.post("/api/me/password")
async def change_my_password(body: PasswordChange, request: Request):
    p = _principal(request)
    if p["guest"] or p["user"] not in auth.store.users:
        raise HTTPException(400, "Sign in with your own account to change its password.")
    m = _m()
    ip = m._client_ip(request)
    forced = bool(p.get("must_change"))
    # the forced first change: this session signed in with the default password moments ago, no need to repeat it
    if not forced or body.current:
        async with _hashing():
            ok = await asyncio.to_thread(auth.store.verify, p["user"], body.current[:1024])
        if not ok:
            if m.auth_limiter.flooding(_pw_key(ip)):
                raise HTTPException(429, "Too many wrong passwords from this device. Wait a few seconds and try again.")
            await m.auth_limiter.punish(_pw_key(ip))
            raise HTTPException(400, "Your current password isn't right")
    async with _hashing():
        same = await asyncio.to_thread(auth.store.verify, p["user"], body.new[:1024])
    if same:
        raise HTTPException(400, "Pick a password different from the current one")
    try:
        # name and password in one save: a failure (taken name, unwritable config folder) changes nothing
        name = auth.store.update_user(p["user"], password=body.new, new_name=(body.username or "").strip() or None)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return _session(name, auth.store.users[name]["role"])   # every other device was signed out; this one stays


# ---------------- admin: users & access ----------------
def _users_view() -> dict:
    return {"users": auth.store.list_users(), "guest_view": auth.store.guest_view, "roles": auth.ROLE_LABEL}


@router.get("/api/users")
async def list_users():
    return _users_view()


@router.post("/api/users")
async def add_user(body: NewUser):
    try:
        auth.store.create_user(body.name or body.username, body.password, body.role)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return _users_view()


@router.patch("/api/users/{name}")
async def patch_user(name: str, body: UserPatch):
    if name not in auth.store.users:
        raise HTTPException(404, "No such user")
    try:
        auth.store.update_user(name, password=body.password, role=body.role)   # all or nothing
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return _users_view()


@router.delete("/api/users/{name}")
async def delete_user(name: str):
    if name not in auth.store.users:
        raise HTTPException(404, "No such user")
    try:
        auth.store.delete_user(name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return _users_view()


@router.put("/api/auth/guest_view")
async def set_guest_view(body: Toggle):
    auth.store.set_guest_view(body.enabled)
    return _users_view()
