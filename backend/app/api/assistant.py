"""Assistant chat endpoint, streamed as Server-Sent Events (status, delta, done, error)."""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
from typing import Any, Iterator, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..assistant import claude, offline
from ..config import get_settings
from ..db import SessionLocal
from .deps import require_ready

router = APIRouter(prefix="/api/assistant", dependencies=[Depends(require_ready)])
log = logging.getLogger("daoguard.assistant")
LINK = re.compile(r"\[([^\]]{1,60})\]\((/[^)\s]*)\)")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatIn(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    context: dict[str, Any] = {}


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.get("/status")
def status() -> dict[str, Any]:
    on = claude.available()
    return {"mode": "claude" if on else "offline", "model": get_settings().ai_model if on else None,
            "label": f"Claude ({get_settings().ai_model}) with live data" if on else "Built-in engine · live data + product guide",
            "suggestions": offline.suggestions({"path": "/"})}


@router.post("/chat")
def chat(body: ChatIn) -> StreamingResponse:
    history = [m.model_dump() for m in body.messages][-20:]
    if history[-1]["role"] != "user":
        history.append({"role": "user", "content": "Please continue."})
    context = {k: v for k, v in (body.context or {}).items() if k in ("path", "proposal_id")}

    def events() -> Iterator[str]:
        db = SessionLocal()
        try:
            if claude.available():
                q: queue.Queue = queue.Queue()
                parts: list[str] = []
                box: dict[str, Any] = {}

                def emit(kind: str, data: dict[str, Any]) -> None:
                    if kind == "delta":
                        parts.append(data["text"])
                    q.put((kind, data))

                def work() -> None:
                    try:
                        box.update(claude.stream_answer(db, history, context, emit))
                    except Exception as exc:  # report, then fall back to the built-in engine
                        log.exception("assistant: Claude engine failed")
                        box["error"] = str(exc)
                    finally:
                        q.put(("end", {}))

                threading.Thread(target=work, daemon=True).start()
                yield _sse("meta", {"mode": "claude"})
                while True:
                    kind, data = q.get()
                    if kind == "end":
                        break
                    yield _sse(kind, data)
                if "error" in box and not parts:
                    yield _sse("status", {"text": "Claude is unavailable; answering with the built-in engine…"})
                else:
                    text = "".join(parts)
                    links = [{"label": a, "to": b} for a, b in LINK.findall(text)][:4]
                    yield _sse("done", {"mode": "claude", "links": links, "sources": box.get("sources", []),
                                        "suggestions": offline.suggestions(context, offline._last_pid(history, context))})
                    return
            # Built-in engine: compose from live data, then stream it out in small chunks.
            yield _sse("meta", {"mode": "offline"})
            yield _sse("status", {"text": "Reading live data…"})
            result = offline.answer(db, history, context)
            for chunk in re.findall(r"\S+\s*", result["text"]):
                yield _sse("delta", {"text": chunk})
                time.sleep(0.008)
            yield _sse("done", {"mode": "offline", **{k: result[k] for k in ("links", "sources", "suggestions")}})
        except Exception as exc:
            log.exception("assistant failed")
            yield _sse("error", {"message": f"The assistant hit an error: {exc}"})
        finally:
            db.close()

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
