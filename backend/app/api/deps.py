from __future__ import annotations

from fastapi import Header

from ..db import get_db  # noqa: F401  (re-exported for routers)
from ..errors import ServiceUnavailable
from ..runtime import runtime


def require_ready() -> None:
    if runtime.state.get("phase") != "ready" or runtime.deployment is None:
        raise ServiceUnavailable("not_ready", runtime.state.get("message") or "DAOGuard is starting", runtime.state)


def actor(x_daoguard_actor: str | None = Header(default=None)) -> str:
    """Display name of the person acting in the UI (demo persona; there is no authentication)."""
    name = (x_daoguard_actor or "Demo reviewer").strip()
    return name[:80] or "Demo reviewer"
