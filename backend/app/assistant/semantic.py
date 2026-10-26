"""Hybrid search over the product guide: BM25 keywords (kb.py) blended with meaning-based
similarity from the local embedding model. Section embeddings are computed once and cached on
disk; without Ollama the search is BM25 alone."""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any

from ..config import get_settings
from . import kb, local_llm

_cache: dict[str, Any] = {}
_lock = threading.Lock()


def _section_vectors():
    import numpy as np

    secs = kb.sections()
    sig = hashlib.sha256(kb.KB_PATH.read_bytes() + get_settings().local_embed_model.encode()).hexdigest()[:16]
    with _lock:
        if _cache.get("sig") == sig:
            return _cache["matrix"]
        path = get_settings().data_dir / "assistant" / f"kb-{sig}.json"
        vecs = None
        if path.exists():
            try:
                vecs = json.loads(path.read_text())
            except ValueError:
                vecs = None
        if vecs is None:
            vecs = local_llm.embed([f"search_document: {s.title}. {', '.join(s.keywords)}. {s.body}"[:2000] for s in secs], timeout=300)
            if vecs is None:
                return None
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(vecs))
            from .nlu import prune_cache

            prune_cache(path)
        m = np.asarray(vecs, dtype=np.float32)
        m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
        _cache.update(sig=sig, matrix=m)
        return m


def search(query: str, k: int = 3) -> list[tuple[float, kb.Section]]:
    """Returns (score 0..1, section) best first. Scores blend BM25 (normalised) and cosine similarity."""
    import numpy as np

    secs = kb.sections()
    bm = {id(s): sc for sc, s in kb.search(query, k=len(secs))}
    m = _section_vectors()
    q = local_llm.embed([f"search_query: {query}"], timeout=8) if m is not None else None
    if m is None or not q:
        return [(min(1.0, sc / 12.0), s) for sc, s in kb.search(query, k=k)]
    v = np.asarray(q[0], dtype=np.float32)
    v /= np.linalg.norm(v) + 1e-9
    cos = m @ v
    scored = []
    for i, s in enumerate(secs):
        # Absolute scales, so the best section only scores high when it really matches:
        # BM25 around 12 is a strong keyword match; cosine for this model sits roughly in 0.35..0.75.
        b = min(1.0, bm.get(id(s), 0.0) / 12.0)
        c = min(1.0, max(0.0, (float(cos[i]) - 0.35) / 0.4))
        scored.append((0.4 * b + 0.6 * c, s))
    scored.sort(key=lambda x: -x[0])
    return scored[:k]


def warm() -> None:
    threading.Thread(target=_section_vectors, name="assistant-kb-vectors", daemon=True).start()
