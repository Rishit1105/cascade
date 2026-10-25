"""Startup orchestration: wait for the local chain, reuse or (re)deploy, seed, start the sentinel.

Runs in a background thread so the API answers immediately with progress while seeding. If the
Hardhat node restarts (new genesis), the sentinel requests a re-bootstrap, because the old
deployment no longer exists on the new chain.
"""

from __future__ import annotations

import logging
import threading
import time

from .chain.deploy import deploy_all, write_labels
from .config import get_settings
from .db import SessionLocal, create_all, drop_all
from .runtime import load_deployment, runtime, save_deployment
from .services.sentinel import Sentinel, mark_cursor_at_head

log = logging.getLogger("daoguard.bootstrap")
_lock = threading.Lock()
_thread: threading.Thread | None = None


def _wait_for_chain(stop: threading.Event | None = None) -> None:
    settings = get_settings()
    attempts = 0
    while not runtime.chain.is_connected():
        attempts += 1
        runtime.set_state("waiting_for_chain", f"Waiting for the local Hardhat node at {settings.rpc_url} (attempt {attempts}). Start it with `npm run dev`.")
        if stop is not None and stop.is_set():
            return
        time.sleep(2)


def _run(reset_chain: bool, reason: str | None) -> None:
    settings = get_settings()
    try:
        if runtime.sentinel is not None:
            runtime.sentinel.stop()
            runtime.sentinel = None
        runtime.deployment = None
        _wait_for_chain()
        chain = runtime.chain
        client = chain.client_version()
        if "hardhat" not in client.lower():
            raise RuntimeError(f"Expected the local Hardhat node, found '{client}'. DAOGuard only runs against its own demo chain.")
        if chain.chain_id != 31337:
            raise RuntimeError(f"Unexpected chain id {chain.chain_id}; the demo node runs chain 31337.")
        if reset_chain:
            runtime.set_state("resetting", reason or "Resetting the demo chain")
            chain.reset()

        create_all()
        db = SessionLocal()
        try:
            existing = load_deployment(db)
            reusable = (
                existing is not None
                and existing.seeded
                and existing.genesis_hash == chain.genesis_hash()
                and chain.get_code(existing.c("guard")) not in ("0x", "0x0")
            )
        finally:
            db.close()

        if reusable:
            runtime.deployment = existing
            log.info("reusing existing deployment (guard %s)", existing.c("guard"))
        else:
            runtime.set_state("deploying", reason or "Deploying the demo contracts to the local chain")
            if chain.block_number() > 0:
                # Leftover state from an interrupted seed or another deployment: start from genesis.
                chain.reset()
            drop_all()
            create_all()
            deployment = deploy_all(chain)
            db = SessionLocal()
            try:
                save_deployment(db, deployment)
                db.commit()
                write_labels(db, deployment)
                runtime.deployment = deployment
                if settings.seed_on_empty_chain:
                    from .seed.demo import Seeder

                    def progress(message: str) -> None:
                        runtime.set_state("seeding", message)
                        log.info("seed: %s", message)

                    Seeder(db, deployment, progress).run()
                deployment.seeded = True
                save_deployment(db, deployment)
                db.commit()
                mark_cursor_at_head(db)
            finally:
                db.close()

        if settings.sentinel_enabled:
            runtime.sentinel = Sentinel(settings.sentinel_poll_seconds)
            runtime.sentinel.start()
        runtime.set_state("ready", "Demo chain deployed and seeded")
        log.info("DAOGuard ready")
    except Exception as exc:
        log.exception("bootstrap failed")
        runtime.deployment = None
        runtime.set_state("error", "Bootstrap failed", f"{type(exc).__name__}: {exc}")


def start(reset_chain: bool = False, reason: str | None = None) -> bool:
    """Start (re)bootstrapping in the background. Returns False if one is already running."""
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return False
        runtime.set_state("starting", reason or "Starting")
        _thread = threading.Thread(target=_run, args=(reset_chain, reason), name="daoguard-bootstrap", daemon=True)
        _thread.start()
        return True


def request_rebootstrap(reason: str) -> None:
    # Called from the sentinel thread; stop() would join itself, so detach it first.
    sentinel = runtime.sentinel
    runtime.sentinel = None
    if sentinel is not None:
        sentinel.signal_stop()
    runtime.deployment = None
    start(reset_chain=False, reason=reason)


def is_running() -> bool:
    return _thread is not None and _thread.is_alive()
