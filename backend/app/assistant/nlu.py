"""Natural-language understanding for the local assistant.

1. Entities: proposals (by id, number, name, nickname or typo), labelled addresses, percentages,
   rule codes, contract errors, ledger event numbers and versions. Each is replaced by a mask
   token (PROPX, ACTORX, ...) so the intent model learns the wording of a question, not names.
2. Intent: a model trained locally on data/intents.json (TF-IDF word and character n-grams into
   logistic regression), blended with nearest-example similarity from a local embedding model
   when Ollama is running. Training takes a few seconds; the result is cached in the data folder
   and rebuilt whenever the training data or library versions change."""

from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import get_settings
from . import local_llm

log = logging.getLogger("daoguard.assistant")
DATA = Path(__file__).with_name("data") / "intents.json"

MASKS = {"p": "PROPX", "a": "ACTORX", "pct": "PCTX", "rule": "RULEX", "term": "TERMX", "seq": "SEQX", "v": "VERX"}
# Contract errors. Only unambiguous spellings are masked: "already executed" is ordinary English.
TERM_PATTERNS = {"manifestmismatch": r"manifest\s?mismatch", "alreadyexecuted": r"alreadyexecuted", "proposalishalted": r"proposalishalted",
                 "notapproved": r"notapproved", "reviewwindowactive": r"review\s?window\s?active", "staleversion": r"staleversion",
                 "unsupportedoperation": r"unsupported\s?operation"}
# Title words too common to identify a proposal on their own ("latest events", "security alerts").
GENERIC = {"events", "event", "budget", "community", "security", "review", "development", "rounding", "reconciliation", "grant", "upgrade", "fee", "fees", "implementation", "meetup"}
_STOP = set("a an the and or of to in on for is are was be by with as at it this that what how do does i you me my we our can from show tell about which who why when where please v1 v2 v3 q1 q2 q3 q4 fix hook proposal".split())
_LEDGER_CTX = re.compile(r"\b(events?|ledger|audit|seq|entry|entries|string|record)\b")
_UNIT_AFTER = r"(?!\s*(?:%|percent|pct|months?|days?|blocks?|k\b|m\b|musdc|usdc|atlas|votes?|hours?|minutes?|mins?|weeks?|years?|tokens?|steps?|points?|pts))"


# --------------------------------------------------------------------------- entities
@dataclass
class Entities:
    proposals: list[str] = field(default_factory=list)
    actors: list[str] = field(default_factory=list)
    pct: int | None = None
    rules: list[str] = field(default_factory=list)
    terms: list[str] = field(default_factory=list)
    seqs: list[int] = field(default_factory=list)
    versions: list[int] = field(default_factory=list)
    release: str | None = None
    deixis: bool = False
    masked: str = ""


@dataclass
class ProposalRef:
    id: str
    title: str
    category: str
    labels: list[str] = field(default_factory=list)


class EntityIndex:
    """Recognises the DAO's own vocabulary. Built from the database (or a fixture in training)."""

    def __init__(self, proposals: list[ProposalRef], actors: list[tuple[str, str, str]]):
        self.proposals = proposals
        self.numbers = {int(p.id.split("-")[1]): p.id for p in proposals if re.fullmatch(r"GOV-\d+", p.id)}
        self.aliases: dict[str, str] = {}
        tokens: dict[str, set[str]] = {}
        for p in proposals:
            words = [w for w in re.findall(r"[a-z0-9]+", p.title.lower()) if w not in _STOP and len(w) > 2]
            for w in words:
                tokens.setdefault(w, set()).add(p.id)
            for a, b in zip(words, words[1:]):
                self.aliases[f"{a} {b}"] = p.id
            if "feevault" in p.title.lower():
                self.aliases["fee vault"] = p.id
        for w, ids in tokens.items():
            if len(ids) == 1 and w not in GENERIC:
                self.aliases[w] = next(iter(ids))
        cats: dict[str, list[str]] = {}
        for p in proposals:
            cats.setdefault(p.category.lower(), []).append(p.id)
        self.categories = {c: ids[0] for c, ids in cats.items() if len(ids) == 1}
        self.actors: dict[str, str] = {}
        self.addresses: dict[str, str] = {}
        generic = {"delegate", "proposer", "recipient", "unlabeled", "demo", "you", "community member", "unknown spender", "unlabeled account", "funding source", "wallet"}
        for label, address, kind in actors:
            self.addresses[address.lower()] = label
            if kind not in ("delegate", "wallet"):  # contracts and services are concepts ("the sentinel"), not people
                continue
            parts = [x.strip().lower() for x in re.split(r"·|\(", label) if x.strip()]
            for part in parts:
                part = re.sub(r"\s*\)$", "", part)
                if part in generic or len(part) < 4 or re.search(r"gov-\d", part):
                    continue
                self.actors[part] = label
                if part.startswith("delegate "):
                    self.actors[part[len("delegate "):]] = label
            if parts and parts[0] == "delegate" and len(parts) > 1:
                self.actors[parts[1]] = label
                self.actors[f"delegate {parts[1]}"] = label
        self._single = sorted({a for a in self.aliases if " " not in a and len(a) >= 5})

    def extract(self, text: str) -> Entities:
        e = Entities()
        t = " " + re.sub(r"\s+", " ", text.lower().replace("’", "'")).strip() + " "
        ledger_ctx = bool(_LEDGER_CTX.search(t))
        hits: list[tuple[int, str]] = []

        def sub(pattern: str, token: str, fn=None, flags=0) -> None:
            nonlocal t

            def rep(m: re.Match) -> str:
                if fn is not None and fn(m) is False:
                    return m.group(0)
                hits.append((m.start(), token))
                return f" {token} "

            t = re.sub(pattern, rep, t, flags=flags)

        sub(r"\b(mi|dg|coi|sim|inj)[\s\-]?r?[\s\-]?(\d{3})\b", "RULEX", lambda m: e.rules.append(f"{m.group(1).upper()}-R{m.group(2)}"))
        for name, pattern in TERM_PATTERNS.items():
            sub(rf"\b{pattern}\b", "TERMX", lambda m, n=name: e.terms.append(n))
        sub(r"(\d{1,3})(?:\.\d+)?\s*(?:%|percent\b|pct\b)", "PCTX", lambda m: setattr(e, "pct", int(m.group(1))) if e.pct is None else None)
        if ledger_ctx:
            sub(r"(?:#|\bevents?\s*#?|\bseq\s*#?|\bentry\s*#?)\s*(\d{1,4})\b", "SEQX", lambda m: e.seqs.append(int(m.group(1))))
            sub(r"(?<=SEQX )(?:and|to|&|vs\.?|with)\s+#?(\d{1,4})\b", "and SEQX", lambda m: e.seqs.append(int(m.group(1))))
        sub(r"\bgov[\s\-_#]*0*(\d{2,4})\b", "PROPX", lambda m: e.proposals.append(f"GOV-{int(m.group(1)):03d}"))

        def bare(m: re.Match) -> bool:
            n = int(m.group(1))
            if n not in self.numbers:
                return False
            e.proposals.append(self.numbers[n])
            return True

        sub(rf"(?<![\w.$])#?(\d{{2,4}})\b{_UNIT_AFTER}", "PROPX", bare)
        # Any other "#N" is a ledger position ("how are #5 and #18 connected").
        sub(r"#(\d{1,4})\b", "SEQX", lambda m: e.seqs.append(int(m.group(1))))
        sub(r"(?<=SEQX )(?:and|to|&|vs\.?|with)\s+(\d{1,4})\b", "and SEQX", lambda m: e.seqs.append(int(m.group(1))))
        sub(r"\b0x[0-9a-f]{40}\b", "ACTORX", lambda m: e.actors.append(self.addresses.get(m.group(0), m.group(0))))
        for alias in sorted((a for a in self.actors if " " in a), key=len, reverse=True):
            sub(rf"\b{re.escape(alias)}\b", "ACTORX", lambda m, a=alias: e.actors.append(self.actors[a]))
        for alias in sorted(self.aliases, key=len, reverse=True):
            sub(rf"\b(?:the\s+)?{re.escape(alias)}(?:\s+(?:proposal|one|grant|upgrade))?\b", "PROPX", lambda m, a=alias: e.proposals.append(self.aliases[a]))
        for cat, pid in self.categories.items():
            sub(rf"\b(?:the|that|this)\s+{re.escape(cat)}s?\b(?!\s+(?:breakdown|items?|split))", "PROPX", lambda m, p=pid: e.proposals.append(p))
        for alias in sorted((a for a in self.actors if " " not in a), key=len, reverse=True):
            sub(rf"\b{re.escape(alias)}\b", "ACTORX", lambda m, a=alias: e.actors.append(self.actors[a]))
        multi = [a for a in self.aliases if " " in a]
        if multi:
            try:
                from rapidfuzz import fuzz, process

                # Two-word typos ("fee valut", "northstr builders"), scanned with a sliding window.
                words, out, i = t.split(" "), [], 0
                while i < len(words):
                    if i + 1 < len(words) and words[i].isalpha() and words[i + 1].isalpha() and words[i].islower() and words[i + 1].islower():
                        best = process.extractOne(f"{words[i]} {words[i + 1]}", multi, scorer=fuzz.ratio, score_cutoff=86)
                        if best:
                            e.proposals.append(self.aliases[best[0]])
                            hits.append((i, "PROPX"))
                            out.append("PROPX")
                            i += 2
                            continue
                    out.append(words[i])
                    i += 1
                t = " ".join(out)
            except ImportError:  # pragma: no cover
                pass
        if self._single:
            try:
                from rapidfuzz import fuzz, process

                def fuzzy(m: re.Match) -> bool:
                    w = m.group(0)
                    best = process.extractOne(w, self._single, scorer=fuzz.ratio, score_cutoff=84)
                    if not best:
                        return False
                    e.proposals.append(self.aliases[best[0]])
                    return True

                sub(r"\b[a-z]{5,}\b", "PROPX", fuzzy)
            except ImportError:  # pragma: no cover
                pass
        sub(r"\bv(?:ersion)?\s?(\d{1,2})\b", "VERX", lambda m: e.versions.append(int(m.group(1))))
        if re.search(r"milestone|tranche|staged|in stages", t):
            e.release = "milestones"
        elif re.search(r"lump|one go|upfront|all at once", t):
            e.release = "lump"
        e.deixis = bool(re.search(r"\b(this|it|its|that|these|them|same|the proposal|this one|that one|the other one)\b", t))
        e.proposals = list(dict.fromkeys(e.proposals))
        e.actors = list(dict.fromkeys(e.actors))
        if len(e.proposals) == 1:  # "halcyon retainer" names one proposal twice
            t = re.sub(r"PROPX(?:\s+(?:the\s+)?PROPX)+", "PROPX", t)
        e.masked = re.sub(r"\s+", " ", t).strip()
        return e


# --------------------------------------------------------------------------- training data
def load_data() -> dict[str, Any]:
    return json.loads(DATA.read_text(encoding="utf-8"))["intents"]


def _mask_template(s: str) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: MASKS.get(m.group(1), m.group(0)), s.lower())


_FILL = {
    "p": ["GOV-042", "gov 43", "42", "#41", "northstar", "the feevault upgrade", "the grant", "meetups", "halcyon retainer", "GOV-044", "fee vault", "proposal 43"],
    "a": ["Kestrel", "delegate Tamsin", "Wallet A", "Northstar Labs", "core-dev.atlas", "Orion Guild"],
    "pct": ["10%", "30 percent", "25%", "50%"],
    "rule": ["MI-R005", "COI-R001", "SIM-R007", "DG-R000"],
    "term": ["ManifestMismatch", "AlreadyExecuted", "ProposalIsHalted", "NotApproved"],
    "seq": ["#5", "#18", "event 12", "#40"],
    "v": ["v2", "version 1", "v3"],
}


def fill_template(s: str, rng: random.Random) -> str:
    return re.sub(r"\{(\w+)\}", lambda m: rng.choice(_FILL.get(m.group(1), [m.group(0)])), s)


_PREFIX = ["hey ", "please ", "can you tell me ", "quick question: ", "i want to know ", "so ", "ok ", "um ", "could you ", "tell me "]
_SUFFIX = ["?", " please", " pls", "??", " thanks", " now", ""]


def _typo(w: str, rng: random.Random) -> str:
    if len(w) < 5 or w.isupper():
        return w
    i = rng.randrange(1, len(w) - 1)
    op = rng.choice(["swap", "drop", "dup"])
    if op == "swap":
        return w[:i] + w[i + 1] + w[i] + w[i + 2:]
    if op == "drop":
        return w[:i] + w[i + 1:]
    return w[:i] + w[i] + w[i:]


def augment(examples: list[str], seed: int = 7) -> list[str]:
    rng = random.Random(seed)
    out = []
    for ex in examples:
        base = _mask_template(ex)
        out.append(base)
        out.append(rng.choice(_PREFIX) + base + rng.choice(_SUFFIX))
        words = base.split()
        if len(words) >= 2:
            out.append(" ".join(_typo(w, rng) if rng.random() < 0.35 else w for w in words))
        if len(words) >= 3 and rng.random() < 0.5:
            drop = rng.randrange(len(words))
            out.append(" ".join(w for i, w in enumerate(words) if i != drop or w.isupper()))
    return out


def data_signature() -> str:
    import sklearn

    return hashlib.sha256(DATA.read_bytes() + sklearn.__version__.encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- model
class IntentModel:
    def __init__(self) -> None:
        self.pipeline = None
        self.labels: list[str] = []
        self.meta: dict[str, dict[str, Any]] = {}
        self.knn: dict[str, Any] | None = None
        self.report: dict[str, Any] = {}

    # Training -------------------------------------------------------------
    def fit(self, intents: dict[str, Any] | None = None) -> "IntentModel":
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import FeatureUnion, Pipeline

        intents = intents or load_data()
        self.meta = {k: {"scope": v["scope"], "description": v["description"]} for k, v in intents.items()}
        X, y = [], []
        for name, spec in intents.items():
            for s in augment(spec["examples"]):
                X.append(s)
                y.append(name)
        self.pipeline = Pipeline([
            ("features", FeatureUnion([
                ("words", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, token_pattern=r"(?u)\b\w+\b|\?")),
                ("chars", TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), sublinear_tf=True, min_df=2)),
            ])),
            ("clf", LogisticRegression(C=12, max_iter=4000, class_weight="balanced")),
        ])
        self.pipeline.fit(X, y)
        self.labels = list(self.pipeline.classes_)
        self.report["training_samples"] = len(X)
        self.report["intents"] = len(self.labels)
        return self

    def build_knn(self, intents: dict[str, Any] | None = None) -> bool:
        """Embeds every training example with the local embedding model (cached on disk)."""
        intents = intents or load_data()
        rng = random.Random(3)
        texts, labels = [], []
        for name, spec in intents.items():
            for ex in spec["examples"]:
                texts.append(fill_template(ex, rng))
                labels.append(name)
        cache = get_settings().data_dir / "assistant" / f"knn-{data_signature()}-{get_settings().local_embed_model.replace(':', '_')}.json"
        vecs = None
        if cache.exists():
            try:
                vecs = json.loads(cache.read_text())
            except ValueError:
                vecs = None
        if vecs is None:
            vecs = local_llm.embed([f"classification: {t}" for t in texts], timeout=600)
            if vecs is None:
                return False
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(vecs))
            prune_cache(cache)
        import numpy as np

        m = np.asarray(vecs, dtype=np.float32)
        m /= np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
        self.knn = {"matrix": m, "labels": labels}
        return True

    # Inference ------------------------------------------------------------
    def predict(self, masked: str, raw: str | None = None, use_knn: bool = True) -> list[tuple[str, float]]:
        import numpy as np

        probs = self.pipeline.predict_proba([masked])[0]
        scores = dict(zip(self.labels, probs))
        if use_knn and self.knn is not None and raw:
            q = local_llm.embed([f"classification: {raw}"], timeout=8)
            if q:
                v = np.asarray(q[0], dtype=np.float32)
                v /= np.linalg.norm(v) + 1e-9
                sims = self.knn["matrix"] @ v
                best: dict[str, float] = {}
                for s, lab in zip(sims, self.knn["labels"]):
                    if s > best.get(lab, -1):
                        best[lab] = float(s)
                keys = list(best)
                arr = np.asarray([best[k] for k in keys]) * 25.0
                arr = np.exp(arr - arr.max())
                arr /= arr.sum()
                knn = dict(zip(keys, arr))
                scores = {k: 0.62 * scores.get(k, 0.0) + 0.38 * float(knn.get(k, 0.0)) for k in self.labels}
        return sorted(scores.items(), key=lambda kv: -kv[1])


_model: IntentModel | None = None
_model_lock = threading.Lock()


def prune_cache(keep: Path) -> None:
    """Deletes older caches of the same kind (intent-*, knn-*, kb-*) once a new one is written."""
    kind = keep.name.split("-", 1)[0]
    for old in keep.parent.glob(f"{kind}-*"):
        if old != keep:
            try:
                old.unlink()
            except OSError:
                pass


def model() -> IntentModel:
    """The trained model, loaded from cache or trained on first use."""
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        import joblib

        cache = get_settings().data_dir / "assistant" / f"intent-{data_signature()}.joblib"
        m: IntentModel | None = None
        if cache.exists():
            try:
                m = joblib.load(cache)
            except Exception:
                m = None
        if m is None:
            m = IntentModel().fit()
            m.knn = None
            cache.parent.mkdir(parents=True, exist_ok=True)
            joblib.dump(m, cache)
            prune_cache(cache)
        _model = m
        return m


def enable_semantic_async() -> None:
    """Adds the embedding layer in the background once the local embedding model is reachable."""

    def run() -> None:
        try:
            m = model()
            if m.knn is None and local_llm.status(refresh=True)["embed"]:
                if m.build_knn():
                    log.info("assistant: semantic intent layer ready (%d examples)", len(m.knn["labels"]))
        except Exception as exc:  # pragma: no cover - best effort
            log.warning("assistant: semantic layer unavailable: %s", exc)

    threading.Thread(target=run, name="assistant-knn", daemon=True).start()
