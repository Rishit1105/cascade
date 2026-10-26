"""Assistant chat endpoint, streamed as Server-Sent Events (meta, status, delta, done, error).

With ANTHROPIC_API_KEY set the Claude engine answers; otherwise the local engine does (a locally
trained intent model and live-data composers, plus open-source models in Ollama when running)."""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
from typing import Any, Callable, Iterator, Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..assistant import claude, engine, local_llm, nlu, offline, semantic
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


def warm_up() -> None:
    """Trains or loads the intent model and warms the local models, all in the background."""

    def run() -> None:
        try:
            nlu.model()
            if local_llm.status(refresh=True)["up"]:
                local_llm.warm_up()
                nlu.enable_semantic_async()
                semantic.warm()
        except Exception:  # pragma: no cover - best effort
            log.exception("assistant warm-up failed")

    threading.Thread(target=run, name="assistant-init", daemon=True).start()


@router.get("/status")
def status() -> dict[str, Any]:
    if claude.available():
        return {"mode": "claude", "model": get_settings().ai_model, "label": f"Claude ({get_settings().ai_model}) with live data",
                "suggestions": offline.suggestions({"path": "/"})}
    m = engine.mode()
    return {**m, "model": m["local_llm"]["chat_model"] if m["local_llm"]["chat"] else None, "suggestions": offline.suggestions({"path": "/"})}


def _stream(work: Callable[[Callable[[str, dict[str, Any]], None]], dict[str, Any]]) -> Iterator[tuple[str, dict[str, Any] | Exception]]:
    """Runs `work(emit)` in a thread and yields what it emits, then ("result", value) or ("failed", exc)."""
    q: queue.Queue = queue.Queue()

    def emit(kind: str, data: dict[str, Any]) -> None:
        q.put((kind, data))

    def run() -> None:
        try:
            q.put(("result", work(emit)))
        except Exception as exc:
            log.exception("assistant engine failed")
            q.put(("failed", exc))

    threading.Thread(target=run, daemon=True).start()
    while True:
        item = q.get()
        yield item
        if item[0] in ("result", "failed"):
            return


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
                parts: list[str] = []
                yield _sse("meta", {"mode": "claude"})
                for kind, data in _stream(lambda emit: claude.stream_answer(db, history, context, emit)):
                    if kind == "delta":
                        parts.append(data["text"])
                    if kind in ("status", "delta"):
                        yield _sse(kind, data)
                    elif kind == "result":
                        text = "".join(parts)
                        links = [{"label": a, "to": b} for a, b in LINK.findall(text)][:4]
                        yield _sse("done", {"mode": "claude", "links": links, "sources": data.get("sources", []),
                                            "suggestions": offline.suggestions(context, offline._last_pid(history, context))})
                        return
                    elif kind == "failed" and parts:
                        yield _sse("error", {"message": f"Claude stopped mid-answer: {data}"})
                        return
                yield _sse("status", {"text": "Claude is unavailable; answering with the local engine…"})
            yield _sse("meta", {"mode": "local"})
            for kind, data in _stream(lambda emit: engine.respond(db, history, context, emit)):
                if kind in ("status", "delta"):
                    yield _sse(kind, data)
                elif kind == "result":
                    yield _sse("done", {"mode": "local", **{k: data[k] for k in ("links", "sources", "suggestions", "understanding")}})
                else:
                    yield _sse("error", {"message": f"The assistant hit an error: {data}"})
        except Exception as exc:
            log.exception("assistant failed")
            yield _sse("error", {"message": f"The assistant hit an error: {exc}"})
        finally:
            db.close()

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
