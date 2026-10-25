"""Shared text utilities: sentence segmentation with offsets, amounts and addresses."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

SENTENCE_RE = re.compile(r"[^\n.!?]+(?:[.!?]+(?=\s|$)|$)", re.MULTILINE)
ADDRESS_RE = re.compile(r"0x[a-fA-F0-9]{40}\b")
AMOUNT_RE = re.compile(
    r"(?P<prefix>\$)?\s?(?P<num>\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(?P<mult>(?:k|K|m|M|million|thousand)\b)?\s?(?P<unit>m?USDC|USD|ATLAS|ETH)?\b"
)


@dataclass
class Sentence:
    doc_id: str
    doc_name: str
    page: int
    section: str | None
    text: str
    start: int
    end: int

    def citation(self) -> dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "doc_name": self.doc_name,
            "page": self.page,
            "section": self.section,
            "quote": self.text,
            "char_start": self.start,
            "char_end": self.end,
        }


def sentences(doc_id: str, doc_name: str, pages: list[dict[str, Any]]) -> list[Sentence]:
    out: list[Sentence] = []
    for page in pages:
        text = page.get("text", "")
        for m in SENTENCE_RE.finditer(text):
            raw = m.group(0)
            stripped = raw.strip().lstrip("-*•# ").strip()
            if len(stripped) < 12:
                continue
            start = m.start() + raw.find(stripped)
            out.append(Sentence(doc_id, doc_name, page.get("page", 1), page.get("section"), stripped, start, start + len(stripped)))
    return out


def parse_amounts(text: str, default_decimals: int = 6) -> list[dict[str, Any]]:
    """Currency-like amounts in base units. Plain numbers without a unit or $ are ignored."""
    found = []
    for m in AMOUNT_RE.finditer(text):
        if not m.group("prefix") and not m.group("unit"):
            continue
        try:
            value = Decimal(m.group("num").replace(",", ""))
        except InvalidOperation:
            continue
        mult = (m.group("mult") or "").lower()
        if mult in ("k", "thousand"):
            value *= 1_000
        elif mult in ("m", "million"):
            value *= 1_000_000
        found.append(
            {
                "text": m.group(0).strip(),
                "value": str(value),
                "base_units": str(int(value * (10**default_decimals))),
                "unit": m.group("unit") or ("USD" if m.group("prefix") else None),
                "start": m.start(),
                "end": m.end(),
            }
        )
    return found


def normalize_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()
