"""In-process publish/subscribe for live UI updates, delivered as Server-Sent Events.

Two kinds of message:
  * ledger:   every audit-ledger event as it is appended (the durable record)
  * activity: ephemeral progress from the sentinel and the simulator (what is happening now)
Publishers run on worker threads; each subscriber is an asyncio queue on the server's event loop.
"""

from __future__ import annotations

import asyncio
import itertools
import threading
from collections import defaultdict, deque
from typing import Any

from ..clock import iso, utcnow

_QUEUE_SIZE = 500


class LiveBus:
    def __init__(self, history: int = 300):
        self._subs: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self._lock = threading.Lock()
        self._history: dict[str, deque[dict[str, Any]]] = defaultdict(lambda: deque(maxlen=history))  # per kind, so ledger bursts never evict activity
        self._ids = itertools.count(1)

    def publish(self, kind: str, data: dict[str, Any]) -> dict[str, Any]:
        msg = {"id": next(self._ids), "kind": kind, "at": iso(utcnow()), **data}
        with self._lock:
            self._history[kind].append(msg)
            subs = list(self._subs)
        for loop, queue in subs:
            try:
                loop.call_soon_threadsafe(_offer, queue, msg)
            except RuntimeError:  # the subscriber's loop has closed
                self._drop(queue)
        return msg

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_SIZE)
        with self._lock:
            self._subs.append((asyncio.get_running_loop(), queue))
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._drop(queue)

    def close(self) -> None:
        """End every open stream (server shutdown) so connections do not hold the process open."""
        with self._lock:
            subs, self._subs = self._subs, []
        for loop, queue in subs:
            try:
                loop.call_soon_threadsafe(_offer, queue, None)
            except RuntimeError:
                pass

    def _drop(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subs = [(lp, q) for lp, q in self._subs if q is not queue]

    def recent(self, proposal_id: str | None = None, kind: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            items = list(self._history[kind]) if kind else sorted((m for q in self._history.values() for m in q), key=lambda m: m["id"])
        if proposal_id:
            items = [m for m in items if m.get("proposal_id") == proposal_id or (m.get("event") or {}).get("proposal_id") == proposal_id]
        return items[-limit:]

    @property
    def subscribers(self) -> int:
        with self._lock:
            return len(self._subs)


def _offer(queue: asyncio.Queue, msg: dict[str, Any] | None) -> None:
    try:
        queue.put_nowait(msg)
    except asyncio.QueueFull:  # a stalled client misses messages rather than blocking publishers
        pass


bus = LiveBus()


def activity(proposal_id: str | None, stage: str, message: str, status: str = "info", **extra: Any) -> None:
    """Report a step of sentinel / simulator work to anyone watching."""
    bus.publish("activity", {"proposal_id": proposal_id, "stage": stage, "message": message, "status": status, **extra})
