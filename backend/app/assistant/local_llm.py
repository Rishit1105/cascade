"""Client for open-source models served locally by Ollama (no data leaves the machine).

Two models are used: an embedding model (nomic-embed-text) for meaning-based search and intent
matching, and a small instruct model (Qwen2.5 3B) for open-ended answers. Both are optional:
when Ollama is not running, every call returns None and the assistant uses its trained intent
model and answer composers alone. Use 127.0.0.1, not localhost: on Windows, localhost tries IPv6
first and adds ~2 s to every request when Ollama listens on IPv4 only."""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Callable, Iterator

import httpx

from ..config import get_settings

log = logging.getLogger("daoguard.assistant")
_state: dict[str, Any] = {"checked": 0.0, "models": set(), "up": False}
_lock = threading.Lock()
KEEP_ALIVE = "30m"


def _client(timeout: float = 120.0) -> httpx.Client:
    return httpx.Client(base_url=get_settings().ollama_url.replace("localhost", "127.0.0.1"), timeout=timeout)


def status(refresh: bool = False) -> dict[str, Any]:
    """Which local models are available. Cached for 20 s so chat requests never wait on a probe."""
    s = get_settings()
    if not s.local_llm_enabled:
        return {"up": False, "chat": False, "embed": False, "chat_model": None, "embed_model": None}
    with _lock:
        if refresh or time.time() - _state["checked"] > 20:
            try:
                with _client(timeout=1.5) as c:
                    tags = c.get("/api/tags").json().get("models", [])
                _state["models"] = {m["name"] for m in tags} | {m["name"].split(":")[0] for m in tags if m["name"].endswith(":latest")}
                _state["up"] = True
            except Exception:
                _state["models"], _state["up"] = set(), False
            _state["checked"] = time.time()
        models = _state["models"]
    return {"up": _state["up"], "chat": s.local_llm_model in models, "embed": s.local_embed_model in models,
            "chat_model": s.local_llm_model, "embed_model": s.local_embed_model}


def embed(texts: list[str], timeout: float = 120.0) -> list[list[float]] | None:
    if not texts or not status()["embed"]:
        return None
    try:
        with _client(timeout) as c:
            out: list[list[float]] = []
            for i in range(0, len(texts), 128):
                for attempt in range(3):  # Ollama's runner occasionally restarts mid-batch; a retry succeeds
                    r = c.post("/api/embed", json={"model": get_settings().local_embed_model, "input": texts[i:i + 128], "keep_alive": KEEP_ALIVE})
                    if r.status_code == 200:
                        break
                    time.sleep(0.4 * (attempt + 1))
                r.raise_for_status()
                out.extend(r.json()["embeddings"])
            return out
    except Exception as exc:
        log.warning("local embedding failed: %s", exc)
        return None


def chat_stream(messages: list[dict[str, str]], on_token: Callable[[str], None], max_tokens: int = 320, temperature: float = 0.2, stop: Callable[[], bool] | None = None) -> str | None:
    """Streams a local-model answer token by token. Returns the full text, or None if unavailable."""
    if not status()["chat"]:
        return None
    parts: list[str] = []
    try:
        with _client(timeout=180) as c, c.stream("POST", "/api/chat", json={
            "model": get_settings().local_llm_model, "messages": messages, "stream": True, "keep_alive": KEEP_ALIVE,
            "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": 4096, "top_p": 0.9, "repeat_penalty": 1.08},
        }) as r:
            r.raise_for_status()
            for line in _lines(r.iter_lines()):
                if stop and stop():
                    break
                piece = line.get("message", {}).get("content", "")
                if piece:
                    parts.append(piece)
                    on_token(piece)
                if line.get("done"):
                    break
        return "".join(parts)
    except Exception as exc:
        log.warning("local chat failed: %s", exc)
        return "".join(parts) or None


def _lines(it: Iterator[str]) -> Iterator[dict[str, Any]]:
    for raw in it:
        if raw.strip():
            try:
                yield json.loads(raw)
            except ValueError:
                continue


def warm_up() -> None:
    """Loads both models in the background so the first question does not pay the load time."""

    def run() -> None:
        st = status(refresh=True)
        try:
            if st["embed"]:
                embed(["search_query: warm up"], timeout=60)
            if st["chat"]:
                with _client(timeout=120) as c:
                    c.post("/api/chat", json={"model": get_settings().local_llm_model, "messages": [{"role": "user", "content": "hi"}],
                                              "stream": False, "keep_alive": KEEP_ALIVE, "options": {"num_predict": 1}})
        except Exception as exc:  # pragma: no cover - best effort
            log.info("local model warm-up skipped: %s", exc)

    threading.Thread(target=run, name="assistant-warmup", daemon=True).start()
