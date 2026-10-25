"""DAOGuard API application."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__, bootstrap
from .api import execution, live, ops, proposals, system
from .chain.client import ChainRPCError, ChainUnavailable, TxReverted
from .config import get_settings
from .db import create_all
from .errors import DomainError
from .runtime import runtime
from .services.live import bus

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
logging.getLogger("web3").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
log = logging.getLogger("daoguard")


@asynccontextmanager
async def lifespan(_: FastAPI):
    create_all()
    bootstrap.start()
    yield
    bus.close()
    if runtime.sentinel is not None:
        runtime.sentinel.stop()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="DAOGuard API",
        version=__version__,
        description="Governance intelligence and execution assurance for DAO proposals (local demo deployment).",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )

    @app.exception_handler(DomainError)
    async def domain_error(_: Request, exc: DomainError):
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        details = [{"path": ".".join(str(p) for p in e.get("loc", [])), "message": e.get("msg")} for e in exc.errors()]
        message = "; ".join(f"{d['path']}: {d['message']}" for d in details[:4])
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error", "message": message, "details": details}})

    @app.exception_handler(ChainUnavailable)
    async def chain_unavailable(_: Request, exc: ChainUnavailable):
        return JSONResponse(status_code=503, content={"error": {"code": "chain_unavailable", "message": str(exc), "details": runtime.state}})

    @app.exception_handler(TxReverted)
    async def tx_reverted(_: Request, exc: TxReverted):
        return JSONResponse(status_code=409, content={"error": {"code": "transaction_would_revert", "message": str(exc), "details": exc.revert}})

    @app.exception_handler(ChainRPCError)
    async def rpc_error(_: Request, exc: ChainRPCError):
        log.error("chain RPC error: %s", exc)
        return JSONResponse(status_code=502, content={"error": {"code": "chain_rpc_error", "message": str(exc), "details": exc.error}})

    for router in (system.router, proposals.router, execution.router, ops.router, live.router):
        app.include_router(router)
    return app


app = create_app()
