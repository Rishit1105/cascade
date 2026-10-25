"""Detect instruction-like text inside evidence (prompt-injection attempts).

Detection is informational: documents are always handled as data. No analysis rule, manifest or
execution decision can be changed by document content, whether or not this detector fires.
"""

from __future__ import annotations

import re
from typing import Any

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("override-instructions", re.compile(r"\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|guidance)\b", re.I)),
    ("role-reassignment", re.compile(r"\byou are (now )?(an? )?(ai|assistant|language model|llm|reviewer|auditor)\b", re.I)),
    ("addressed-to-ai", re.compile(r"\b(note|message|instruction)s? (to|for) (any )?(ai|automated|llm|language model)s?( reviewers?| systems?| tools?)?\b", re.I)),
    ("verdict-steering", re.compile(r"\b(mark|classify|label|report|rate|treat)\b[^.\n]{0,30}\b(proposal|this)\b[^.\n]{0,20}\bas\b[^.\n]{0,10}\b(safe|approved|low[- ]risk|fully evidenced|compliant|verified|trusted)\b", re.I)),
    ("suppression", re.compile(r"\bdo not (flag|report|mention|highlight|surface)\b", re.I)),
    ("system-tags", re.compile(r"<\s*/?\s*(system|instructions?|assistant)\s*>", re.I)),
    ("system-prompt", re.compile(r"\bsystem prompt\b", re.I)),
]
INVISIBLE = re.compile(r"[​-‏⁠-⁤﻿]")


def scan_pages(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flags: list[dict[str, Any]] = []
    for page in pages:
        text = page.get("text", "")
        for name, pattern in PATTERNS:
            for m in pattern.finditer(text):
                line_start = text.rfind("\n", 0, m.start()) + 1
                line_end = text.find("\n", m.end())
                line_end = len(text) if line_end == -1 else line_end
                flags.append(
                    {
                        "pattern": name,
                        "page": page.get("page", 1),
                        "section": page.get("section"),
                        "quote": text[line_start:line_end].strip()[:400],
                        "char_start": m.start(),
                        "char_end": m.end(),
                    }
                )
        hidden = INVISIBLE.findall(text)
        if hidden:
            flags.append(
                {
                    "pattern": "invisible-characters",
                    "page": page.get("page", 1),
                    "section": page.get("section"),
                    "quote": f"{len(hidden)} zero-width / invisible character(s) present",
                    "char_start": None,
                    "char_end": None,
                }
            )
    return flags
