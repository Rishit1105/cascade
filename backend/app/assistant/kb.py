"""Product knowledge base for the assistant: sections of knowledge.md, searchable with BM25."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

KB_PATH = Path(__file__).with_name("knowledge.md")
_WORD = re.compile(r"[a-z0-9][a-z0-9\-_.]*")
_STOP = set("a an the and or of to in on for is are was be by with as at it this that what how do does i you me my we our can from show tell about which who why when where please".split())
# Everyday words people use for product terms.
_SYNONYMS = {
    "risky": ["risk", "evaluation", "chain"], "danger": ["risk"], "safe": ["security", "limits"], "money": ["treasury", "funds"],
    "funds": ["treasury"], "budget": ["budget", "treasury"], "grant": ["proposal", "treasury"], "hack": ["attack", "backdoor", "simulation"],
    "backdoor": ["simulation", "comparison", "syncaccounting"], "attack": ["simulation", "comparison"], "drain": ["syncaccounting", "comparison"],
    "stop": ["halt", "sentinel"], "block": ["halt", "guard"], "vote": ["voting", "governor"], "delegate": ["voting", "delegates"],
    "chatbot": ["assistant"], "bot": ["assistant"], "ai": ["claude", "assistant", "injection"], "llm": ["claude", "injection"],
    "start": ["run", "setup"], "install": ["setup", "run"], "launch": ["run"], "hash": ["digest", "ledger"], "proof": ["ledger", "verify"],
    "tamper": ["ledger", "verify", "manifest"], "conflicts": ["conflict", "relationships"], "relationship": ["relationships", "conflict"],
    "questions": ["q&a", "questions"], "answer": ["q&a"], "3d": ["3d", "surface"], "chart": ["financial", "projection"],
}


@dataclass
class Section:
    title: str
    body: str
    keywords: list[str]
    link: str | None
    tokens: list[str] = field(default_factory=list)


def tokenize(text: str) -> list[str]:
    return [w.strip(".-_") for w in _WORD.findall(text.lower()) if w.strip(".-_") and w not in _STOP]


@lru_cache(maxsize=1)
def sections() -> tuple[Section, ...]:
    raw = KB_PATH.read_text(encoding="utf-8")
    out: list[Section] = []
    for chunk in re.split(r"^## ", raw, flags=re.M)[1:]:
        title, _, rest = chunk.partition("\n")
        keywords: list[str] = []
        link = None
        body_lines = []
        for line in rest.strip().splitlines():
            if line.startswith("Keywords:"):
                keywords = [k.strip() for k in line[len("Keywords:"):].split(",") if k.strip()]
            elif line.startswith("Open:"):
                link = line[len("Open:"):].strip()
            else:
                body_lines.append(line)
        body = "\n".join(body_lines).strip()
        s = Section(title.strip(), body, keywords, link)
        # Title and keywords count more than body text.
        s.tokens = tokenize(s.title) * 3 + tokenize(" ".join(keywords)) * 3 + tokenize(body)
        out.append(s)
    return tuple(out)


def full_text() -> str:
    return KB_PATH.read_text(encoding="utf-8")


def search(query: str, k: int = 3) -> list[tuple[float, Section]]:
    secs = sections()
    q = tokenize(query)
    q += [syn for w in list(q) for syn in _SYNONYMS.get(w, [])]
    if not q:
        return []
    n = len(secs)
    avg = sum(len(s.tokens) for s in secs) / n
    df = {t: sum(1 for s in secs if t in s.tokens) for t in set(q)}
    scored = []
    for s in secs:
        score = 0.0
        for t in set(q):
            tf = s.tokens.count(t)
            if not tf:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * len(s.tokens) / avg))
        # Exact phrase in keywords is a strong signal ("review window", "manifest builder").
        ql = query.lower()
        score += sum(2.5 for kw in s.keywords if len(kw) > 3 and kw in ql)
        if score > 0:
            scored.append((score, s))
    scored.sort(key=lambda x: -x[0])
    return scored[:k]
