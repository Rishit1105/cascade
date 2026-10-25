"""Server-Sent Events stream of ledger events and sentinel / simulator activity."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from ..services.live import bus

router = APIRouter(prefix="/api")
KEEPALIVE_SECONDS = 15


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    queue = bus.subscribe()

    async def events():
        try:
            yield f"retry: 3000\nevent: hello\ndata: {json.dumps({'subscribers': bus.subscribers})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=KEEPALIVE_SECONDS)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if msg is None:  # server shutting down
                    break
                yield f"id: {msg['id']}\nevent: {msg['kind']}\ndata: {json.dumps(msg, default=str)}\n\n"
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/activity")
def recent_activity(proposal: str | None = None, kind: str | None = Query(default=None, pattern="^(ledger|activity)$"), limit: int = Query(default=60, ge=1, le=300)) -> dict[str, Any]:
    """Recent live messages (kept in memory) so a page opened mid-review can show what already happened."""
    return {"items": bus.recent(proposal, kind, limit)}
