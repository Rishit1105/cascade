"""Single source of "now" for off-chain records.

During seeding the local chain is time-travelled through a 30-day history; off-chain records
created at those moments must carry the chain's timestamp, not the wall clock. `pinned()` lets
the seeder align both.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import contextmanager
from datetime import UTC, datetime

_state = threading.local()


def utcnow() -> datetime:
    pinned_at = getattr(_state, "pinned", None)
    if pinned_at is None:
        return datetime.now(UTC)
    return pinned_at() if callable(pinned_at) else pinned_at


@contextmanager
def pinned(moment: datetime | Callable[[], datetime]):
    previous = getattr(_state, "pinned", None)
    _state.pinned = moment
    try:
        yield
    finally:
        _state.pinned = previous


def from_timestamp(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, UTC)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")
