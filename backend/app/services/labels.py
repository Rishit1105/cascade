"""Address labelling and token formatting used by every human-readable explanation."""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal

from eth_utils import keccak, to_checksum_address
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AddressLabel
from ..runtime import runtime

ROLE_HASHES = {
    "0x" + "00" * 32: "DEFAULT_ADMIN_ROLE",
    "0x" + keccak(text="GOVERNOR_ROLE").hex(): "GOVERNOR_ROLE",
    "0x" + keccak(text="EXECUTOR_ROLE").hex(): "EXECUTOR_ROLE",
    "0x" + keccak(text="GUARDIAN_ROLE").hex(): "GUARDIAN_ROLE",
    "0x" + keccak(text="COMMITTER_ROLE").hex(): "COMMITTER_ROLE",
    "0x" + keccak(text="ANCHOR_ROLE").hex(): "ANCHOR_ROLE",
}


class Labeler:
    """Snapshot of address labels for one request; cheap to build, avoids N queries."""

    def __init__(self, db: Session):
        self._labels = {row.address.lower(): row for row in db.scalars(select(AddressLabel))}

    def label(self, address: str | None) -> str | None:
        if not address:
            return None
        row = self._labels.get(address.lower())
        return row.label if row else None

    def kind(self, address: str | None) -> str | None:
        if not address:
            return None
        row = self._labels.get(address.lower())
        return row.kind if row else None

    def role(self, address: str | None) -> str | None:
        if not address:
            return None
        row = self._labels.get(address.lower())
        return row.role if row else None

    def describe(self, address: str | None) -> str:
        if not address:
            return "(none)"
        name = self.label(address)
        return f"{name} ({short_address(address)})" if name else short_address(address)

    def known(self, address: str) -> bool:
        return address.lower() in self._labels


def short_address(address: str) -> str:
    a = to_checksum_address(address)
    return f"{a[:6]}…{a[-4:]}"


def token_meta(address: str | None) -> tuple[str, int] | None:
    """(symbol, decimals) for tokens in the demo deployment."""
    deployment = runtime.deployment
    if not deployment or not address:
        return None
    if address.lower() == deployment.c("usdc").lower():
        return ("mUSDC", 6)
    if address.lower() == deployment.c("atlas").lower():
        return ("ATLAS", 18)
    return None


def format_units(amount: int | str, decimals: int, places: int = 2) -> str:
    value = Decimal(int(amount)) / (Decimal(10) ** decimals)
    quantum = Decimal(1).scaleb(-places)
    rounded = value.quantize(quantum, rounding=ROUND_HALF_EVEN)
    text = f"{rounded:,.{places}f}"
    if places and text.endswith("0" * places):
        text = text[: -(places + 1)]
    return text


def format_token(amount: int | str, token_address: str | None, fallback_symbol: str = "", fallback_decimals: int = 18) -> str:
    meta = token_meta(token_address)
    symbol, decimals = meta if meta else (fallback_symbol, fallback_decimals)
    if int(amount) == 2**256 - 1:
        return f"unlimited {symbol}".strip()
    return f"{format_units(amount, decimals)} {symbol}".strip()
