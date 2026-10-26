"""Train and evaluate the assistant's intent model locally.

    python -m app.assistant.train            # train, evaluate, cache the model
    python -m app.assistant.train --no-knn   # skip the embedding layer even if Ollama is running

Evaluation runs end to end through the same entity masking used at runtime, on (a) the held-out
'tests' phrasings in data/intents.json and (b) 5-fold cross-validation over the examples."""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter
from typing import Any

from ..config import get_settings
from . import local_llm, nlu

# The demo DAO's vocabulary, so the model can be evaluated without a database or chain.
FIXTURE_PROPOSALS = [
    nlu.ProposalRef("GOV-041", "Q3 security review retainer: Halcyon Security", "retainer"),
    nlu.ProposalRef("GOV-042", "Ecosystem Development Grant: Northstar Builders", "grant"),
    nlu.ProposalRef("GOV-043", "FeeVault v2: fee rounding fix and reconciliation hook", "upgrade"),
    nlu.ProposalRef("GOV-044", "Community events budget: Q1 meetups", "budget"),
]
FIXTURE_ACTORS = [(label, f"0x{i:040x}", kind) for i, (label, kind) in enumerate([
    ("Delegate · Kestrel", "delegate"), ("Delegate · Tamsin", "delegate"), ("Delegate · Orion Guild", "delegate"), ("Delegate · Halden", "delegate"),
    ("Wallet A · Northstar Builders", "wallet"), ("Northstar Labs · proposer", "wallet"), ("core-dev.atlas · proposer", "wallet"),
    ("Events working group · proposer", "wallet"), ("Halcyon Security · GOV-041 recipient", "wallet"), ("DAOGuard sentinel", "service"),
], start=1)]


def fixture_index() -> nlu.EntityIndex:
    return nlu.EntityIndex(FIXTURE_PROPOSALS, FIXTURE_ACTORS)


def evaluate(model: nlu.IntentModel, cases: list[tuple[str, str]], index: nlu.EntityIndex, use_knn: bool) -> dict[str, Any]:
    rng = random.Random(11)
    correct, misses = 0, []
    per: dict[str, list[int]] = {}
    for template, gold in cases:
        raw = nlu.fill_template(template, rng)
        e = index.extract(raw)
        top = model.predict(e.masked, raw, use_knn=use_knn)[0][0]
        ok = top == gold
        correct += ok
        per.setdefault(gold, [0, 0])
        per[gold][0] += ok
        per[gold][1] += 1
        if not ok:
            misses.append({"text": raw, "expected": gold, "got": top})
    return {"accuracy": round(correct / max(1, len(cases)), 4), "n": len(cases), "per_intent": {k: f"{a}/{b}" for k, (a, b) in sorted(per.items())}, "misses": misses}


def cross_validate(intents: dict[str, Any], index: nlu.EntityIndex, folds: int = 5) -> float:
    rng = random.Random(5)
    split: dict[str, list[list[str]]] = {}
    for name, spec in intents.items():
        ex = spec["examples"][:]
        rng.shuffle(ex)
        split[name] = [ex[i::folds] for i in range(folds)]
    scores = []
    for k in range(folds):
        train = {n: {**s, "examples": [x for i, part in enumerate(split[n]) if i != k for x in part]} for n, s in intents.items()}
        held = [(x, n) for n in intents for x in split[n][k]]
        m = nlu.IntentModel().fit(train)
        scores.append(evaluate(m, held, index, use_knn=False)["accuracy"])
    return round(sum(scores) / len(scores), 4)


def train(use_knn: bool = True, verbose: bool = True) -> dict[str, Any]:
    t0 = time.time()
    intents = nlu.load_data()
    index = fixture_index()
    model = nlu.IntentModel().fit(intents)
    tests = [(t, name) for name, spec in intents.items() for t in spec.get("tests", [])]
    report: dict[str, Any] = {"signature": nlu.data_signature(), "intents": len(intents), "examples": sum(len(s["examples"]) for s in intents.values()),
                              "training_samples": model.report["training_samples"], "held_out_tests": len(tests)}
    report["held_out"] = evaluate(model, tests, index, use_knn=False)
    report["cross_validation_accuracy"] = cross_validate(intents, index)
    if use_knn and local_llm.status(refresh=True)["embed"] and model.build_knn(intents):
        report["held_out_with_embeddings"] = evaluate(model, tests, index, use_knn=True)
    report["seconds"] = round(time.time() - t0, 1)

    import joblib

    out = get_settings().data_dir / "assistant"
    out.mkdir(parents=True, exist_ok=True)
    knn, model.knn = model.knn, None  # embeddings are cached separately; the classifier pickle stays small
    joblib.dump(model, out / f"intent-{report['signature']}.joblib")
    nlu.prune_cache(out / f"intent-{report['signature']}.joblib")
    model.knn = knn
    (out / "training-report.json").write_text(json.dumps(report, indent=2))
    if verbose:
        _print(report)
    return report


def _print(r: dict[str, Any]) -> None:
    print(f"Intent model · {r['intents']} intents · {r['examples']} examples → {r['training_samples']} augmented samples · {r['seconds']}s")
    print(f"  5-fold cross-validation accuracy : {r['cross_validation_accuracy']:.1%}")
    print(f"  held-out tests (classifier)      : {r['held_out']['accuracy']:.1%}  ({r['held_out']['n']} phrasings never seen in training)")
    if "held_out_with_embeddings" in r:
        print(f"  held-out tests (+ embeddings)    : {r['held_out_with_embeddings']['accuracy']:.1%}")
    worst = Counter((m["expected"], m["got"]) for m in r.get("held_out_with_embeddings", r["held_out"])["misses"])
    if worst:
        print("  misses:")
        for m in r.get("held_out_with_embeddings", r["held_out"])["misses"][:25]:
            print(f"    {m['text']!r}: expected {m['expected']}, got {m['got']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-knn", action="store_true")
    args = ap.parse_args()
    train(use_knn=not args.no_knn)
    sys.exit(0)
