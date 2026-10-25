# DAOGuard: DAO governance intelligence and execution assurance

CASCADE '26 · Theme 4 (Information Asymmetry) · Problem 1: The Governance Illusion.

**Understand the decision. Verify the execution. Preserve the evidence.**

All entities, amounts and transactions are fictional demo data on a local Hardhat chain. No real funds.

## Run it

```bash
npm run setup   # first time: npm packages, Python venv, contract compile + ABI export
npm run dev     # Hardhat node :8545, FastAPI :8000, web app :5173
```

Open http://127.0.0.1:5173. The first start deploys the contracts and seeds a 30-day history (about 10 s). On Windows you can double-click `Start-DAOGuard.cmd`. Settings → Reset demo rebuilds everything.

Requirements: Node 20.11+, Python 3.11+. Optional: `ANTHROPIC_API_KEY` in `backend/.env` enables Claude interpretation of documents (see `backend/.env.example`). Without a key the brief is a clearly labelled deterministic extraction.

## Architecture

| Layer | Tech | What it does |
|---|---|---|
| Contracts (`contracts/`) | Solidity 0.8.28, OpenZeppelin 5, Hardhat | `ExecutionGuard` (treasury that executes only the exact EIP-712 manifest digest governance approved; review window; guardian halt that can only block), `AtlasGovernor` (token voting whose only action is `approveManifest`), `ProposalRegistry` (append-only version commits with proposer-signed disclosures, audit-ledger anchors, disputes), `FeeVault` + an honest and an obfuscated V2 for the contested-upgrade scenario |
| Backend (`backend/`) | FastAPI, Pydantic, SQLAlchemy/SQLite, web3.py | Proposal versions and diffs, evidence hashing and Merkle roots, extractive brief with citations, missing-information rules, prompt-injection detection, treasury maths in base units, conflict-of-interest graph from chain events, deterministic payload rules, bytecode analysis and snapshot simulation, sentinel that auto-halts on-chain, hash-chained audit ledger anchored on-chain, alerts, PDF/JSON/CSV reports |
| Frontend (`frontend/`) | React 18, Vite, TypeScript, Tailwind, React Query, Recharts, d3-force | Overview with the probabilistic evaluation chain, proposals workspace, relationship explorer, version diff, financial impact, voting and delegates, execution guardian, audit timeline, escalation, reports, settings. Light theme by default with a dark theme toggle |

## Demo walkthrough

1. **Overview**: the four-stage chain (Proposal Claims → Conflict of Interest → On-chain Voting → Execution Discrepancy), with every likelihood ratio listed.
2. **Proposals → GOV-042**: cited brief, the 520k vs 500k contradiction, and the undisclosed proposer → recipient transfer.
3. **Execution guardian → GOV-042 → Changed recipient → Execute guarded demo**: the contract reverts with `ManifestMismatch` (real tx hash, nothing moves). Then **Approved payload** executes, and a replay is rejected with `AlreadyExecuted`.
4. **GOV-043 (contested upgrade) → Simulate contract run**: the submitted bytecode hard-codes an address that can drain the vault through `syncAccounting()`, contradicting "moves no funds". The reviewed implementation passes.
5. **Proposals → GOV-043 → Finalize vote**: the sentinel simulates the approved manifest and halts it on-chain inside the review window. Executing then fails with `ProposalIsHalted`.
6. **Audit timeline → Verify on-chain**: hash links, re-checked receipts and anchored ledger heads.

## Tests

```bash
npm run test:contracts   # 25 Hardhat tests: every rejection case, Governor e2e, registry, upgrade fixtures
npm run test:backend     # 22 unit + 23 integration tests (starts its own node on :8546)
```

## Honest limits

A hash proves equality with what was committed, not truth. A transfer edge shows value moved, not common ownership. Simulation covers the probed callers and the current state, so it cannot prove the absence of backdoors (for example magic-argument triggers). The guard only protects execution routed through it. Votes are cast by demo delegate accounts. This is a prototype: no real treasury, no audited contracts.
