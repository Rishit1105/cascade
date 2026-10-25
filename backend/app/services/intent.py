"""Extract testable intent assertions from a proposal's human-readable text.

Deterministic pattern rules turn sentences such as "No changes to custody" or "`syncAccounting()`
is accounting-only" into assertions the simulator can confirm or refute. Every assertion keeps
the exact quote and character offsets it came from, so reviewers can see what was parsed.
"""

from __future__ import annotations

import re
from typing import Any

SENTENCE_RE = re.compile(r"[^\n.!?]+(?:[.!?]+|$)", re.MULTILINE)
FUNC_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)(?:\([^`]*\))?`")
CALL_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)\([^`]*\)`")
LIST_MARKER_RE = re.compile(r"^(?:[-*•]|\d+[.)])\s+")

PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("CUSTODY_UNCHANGED", re.compile(r"no changes? to custody|funds? (?:remain|stay)s? in the vault|can only (?:ever )?be swept to the (?:dao )?treasury", re.I),
     "Funds stay where they are: no new path moves vault or treasury funds elsewhere."),
    ("OWNERSHIP_UNCHANGED", re.compile(r"no changes? to (?:the )?(?:proxy admin|admin|ownership|owner)|remains the only upgrade authority", re.I),
     "Admin / ownership / upgrade authority is unchanged."),
    ("NO_NEW_PRIVILEGES", re.compile(r"no new (?:privileged )?(?:roles|functions|permissions|privileges)|no changes? to (?:withdrawal )?permissions", re.I),
     "No new privileged roles, permissions or caller-specific powers."),
    ("NO_FUNCTIONAL_CHANGE", re.compile(r"no functional change|functionally identical|behaviou?rally identical", re.I),
     "Behaviour is identical to the previously reviewed implementation."),
    ("FEE_ROUNDING_HALF_UP", re.compile(r"rounds? half[- ]up|round(?:ing)? half[- ]up", re.I),
     "Fee quotes round half-up instead of down."),
]
ACCOUNTING_ONLY_RE = re.compile(r"accounting[- ]only|moves? no funds|only updates? (?:the )?internal", re.I)


def _sentences(text: str) -> list[tuple[int, int, str]]:
    out = []
    for m in SENTENCE_RE.finditer(text):
        raw = m.group(0)
        stripped = LIST_MARKER_RE.sub("", raw.strip())
        if len(stripped) < 4:
            continue
        start = m.start() + raw.find(stripped)
        out.append((start, start + len(stripped), stripped))
    return out


def extract_assertions(text: str, source: str = "proposal_text") -> dict[str, Any]:
    assertions: list[dict[str, Any]] = []
    declared_functions: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for start, end, sentence in _sentences(text or ""):
        for name in FUNC_RE.findall(sentence):
            if name[0].islower():
                declared_functions.add(name)
        funcs = [n for n in CALL_RE.findall(sentence) if n[0].islower()]
        if funcs and ACCOUNTING_ONLY_RE.search(sentence):
            for fn in funcs:
                key = ("FUNCTION_MOVES_NO_FUNDS", fn)
                if key not in seen:
                    seen.add(key)
                    assertions.append(
                        {
                            "kind": "FUNCTION_MOVES_NO_FUNDS",
                            "claim": f"`{fn}` only updates accounting and moves no funds.",
                            "params": {"function": fn},
                            "quote": sentence,
                            "source": {"type": source, "char_start": start, "char_end": end},
                        }
                    )
            continue
        for kind, pattern, claim in PATTERNS:
            if pattern.search(sentence) and (kind, "") not in seen:
                seen.add((kind, ""))
                assertions.append(
                    {
                        "kind": kind,
                        "claim": claim,
                        "params": {},
                        "quote": sentence,
                        "source": {"type": source, "char_start": start, "char_end": end},
                    }
                )
    for i, a in enumerate(assertions, start=1):
        a["id"] = f"IA-{i:02d}"
    return {
        "method": "deterministic pattern rules (no LLM)",
        "assertions": assertions,
        "declared_functions": sorted(declared_functions),
    }


def transfer_assertions(approved_decoded: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for d in approved_decoded:
        if d.get("kind") == "erc20_transfer":
            out.append(
                {
                    "kind": "EXACT_TRANSFER",
                    "claim": d["human_readable"],
                    "params": {
                        "token": d["token_address"],
                        "recipient": d["expected_recipient"],
                        "amount": d["expected_amount_base"],
                    },
                    "quote": d["human_readable"],
                    "source": {"type": "approved_manifest", "action_index": d.get("index")},
                }
            )
    return out
