import logging
import os
import re
from pathlib import Path

import yaml

CONFIG_PATH = Path(os.getenv("HAVEN_CONFIG", "/config/config.yaml"))
DATA_DIR = Path(os.getenv("HAVEN_DATA", "/data"))
# Configuration you make in Haven (settings, accounts, layout, automations, trusted gateways) lives next to
# config.yaml in the config folder; DATA_DIR keeps history, sessions, sign-in tokens and certificates.
# Without a config folder (tests, running from source) both are DATA_DIR.
def _has_conf_dir() -> bool:
    try:
        return CONFIG_PATH.parent.is_dir()
    except OSError:          # can't even look (permissions): treat as present, check_data_dir() reports it
        return True


_conf = os.getenv("HAVEN_CONF_DIR") or (str(CONFIG_PATH.parent) if _has_conf_dir() else "")
CONF_DIR: Path | None = Path(_conf) if _conf else None
CONFIG_FILES = ("settings.json", "users.json", "layout.json", "overrides.json", "automations.json",
                "ecowitt_gateways.json")


def conf_dir() -> Path:
    return CONF_DIR if CONF_DIR is not None else DATA_DIR

log = logging.getLogger("config")


_told = False
_ENV = re.compile(r"\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}")


def _substitute(text: str) -> str:
    """Replace ${VAR} / ${VAR:-default} with environment values so secrets stay in haven.env."""
    return _ENV.sub(lambda m: os.getenv(m.group(1), m.group(2) or ""), text)


def _walk(node):
    if isinstance(node, dict):
        return {k: _walk(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_walk(v) for v in node]
    if isinstance(node, str) and "${" in node:
        return _substitute(node)
    return node


# Without a config.yaml Haven starts with these, and nothing else: no example or demo devices. Everything else
# is switched on in Settings. (config/config.example.yaml documents every option; it is never loaded.)
DEFAULTS = {
    "mqtt": {"enabled": True, "host": "mosquitto", "port": 1883, "discovery": True, "discovery_prefix": "homeassistant"},
    "ecowitt": {"enabled": True},
    "history": {"enabled": True, "backend": "sqlite", "sample_seconds": 60, "retention_days": 365},
    "demo": {"enabled": False},
}


def load_config() -> dict:
    path = CONFIG_PATH
    if not path.exists():
        global _told
        if not _told:
            _told = True
            log.info("%s not found: starting with the defaults (MQTT broker \"mosquitto\", Ecowitt, history). "
                     "Add your accounts in Settings.", CONFIG_PATH)
        import copy
        return copy.deepcopy(DEFAULTS)
    try:
        # Parse first, then fill in ${VARS} inside string values only, so secrets containing
        # YAML-special characters (#, *, :, quotes) can't break or truncate the file.
        return _walk(yaml.safe_load(path.read_text()) or {})
    except yaml.YAMLError as e:
        log.error("config.yaml has a formatting error (check indentation, use spaces not tabs): %s", e)
        return {}


STORAGE_PROBLEM = ""      # shown in the dashboard when a folder can't be written


def storage_hint(path) -> str:
    return (f"Haven can't save to {path} (running as uid {os.getuid()}, groups "
            f"{','.join(map(str, os.getgroups())) or os.getgid()}). On Synology, run Haven as your own DSM user: over "
            "SSH run `id` and set HAVEN_UID, HAVEN_GID and HAVEN_GROUPS in the compose file to those numbers "
            "(e.g. 1024, 100 and 101), then Build again. Or in File Station give that user Read & Write on docker/haven.")


def check_data_dir() -> str:
    """Can Haven write its folders? Logs loudly and returns a message if not (keeps running)."""
    global STORAGE_PROBLEM
    problems = []
    for d in dict.fromkeys([DATA_DIR, conf_dir()]):
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / ".write_test"
            probe.write_text("ok")
            probe.unlink()
        except OSError as e:
            log.error("Cannot write to %s (%s). %s", d, e, storage_hint(d))
            problems.append(storage_hint(d))
    STORAGE_PROBLEM = " ".join(problems)
    return STORAGE_PROBLEM


def write_private(path, data, binary: bool = False) -> None:
    """Atomically write a secret file that is readable only by the container user (0600 from
    creation, never world-readable even briefly)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb" if binary else "w") as f:
            f.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

