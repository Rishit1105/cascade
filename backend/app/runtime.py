"""Process-wide runtime context: chain client, active deployment, background services."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from .chain.client import ChainClient
from .config import get_settings
from .models import KeyValue

# Demo account roles by index of the node's unlocked accounts (Hardhat default mnemonic).
# Labels are fictional annotations. They are never claims about real-world identity.
ACCOUNT_ROLES: list[tuple[str, int, str, str, str]] = [
    ("deployer", 0, "Deployer (demo setup)", "service", "Deployed the demo contracts."),
    ("executor", 1, "Ops executor (demo)", "service", "Holds EXECUTOR_ROLE on the ExecutionGuard."),
    ("sentinel", 2, "DAOGuard sentinel", "service", "Holds GUARDIAN_ROLE (halt only) and commits versions."),
    ("proposer_042", 3, "Northstar Labs · proposer", "wallet", "Author of GOV-042 (fictional)."),
    ("wallet_a", 4, "Wallet A · Northstar Builders", "wallet", "Approved GOV-042 grant recipient (fictional)."),
    ("wallet_b", 5, "Wallet B · unlabeled", "wallet", "Address used in the recipient-tampering scenario."),
    ("proposer_043", 6, "core-dev.atlas · proposer", "wallet", "Author of GOV-043 (fictional)."),
    ("reconciler", 7, "Reconciler · unlabeled", "wallet", "Address embedded in the GOV-043 v2 implementation."),
    ("d01", 8, "Delegate · Meridian", "delegate", "Demo delegate."),
    ("d02", 9, "Delegate · Kestrel", "delegate", "Demo delegate."),
    ("d03", 10, "Delegate · Halden", "delegate", "Demo delegate."),
    ("d04", 11, "Delegate · Orion Guild", "delegate", "Demo delegate."),
    ("d05", 12, "Delegate · Larkspur", "delegate", "Demo delegate."),
    ("d06", 13, "Delegate · Ridgeline", "delegate", "Demo delegate."),
    ("d07", 14, "Delegate · Tamsin", "delegate", "Demo delegate."),
    ("d08", 15, "Delegate · Coastal", "delegate", "Demo delegate."),
    ("d09", 16, "Delegate · Ember", "delegate", "Demo delegate."),
    ("d10", 17, "Delegate · Juniper", "delegate", "Demo delegate."),
    ("auditor", 18, "Halcyon Security · GOV-041 recipient", "wallet", "Security audit vendor (fictional)."),
    ("proposer_044", 19, "Events working group · proposer", "wallet", "Author of GOV-044 (fictional)."),
    ("fee_payer", 20, "Protocol fee router (demo)", "service", "Pays protocol fees into the FeeVault."),
    ("community", 21, "You · community member", "wallet", "The demo voter you can act as."),
    ("funder", 22, "Funding source · exchange wallet", "wallet", "Common funding source (fictional)."),
    ("attacker", 23, "Unknown spender", "wallet", "Spender used in the extra-allowance scenario."),
    ("events_multisig", 24, "Events WG multisig", "wallet", "Recipient named in GOV-044 (fictional)."),
    ("spare", 25, "Unlabeled account", "wallet", "Unused demo account."),
]

DELEGATE_ROLES = [r[0] for r in ACCOUNT_ROLES if r[3] == "delegate"]
VOTER_ROLES = DELEGATE_ROLES + ["proposer_042", "proposer_043", "proposer_044", "community", "auditor"]

CONTRACT_LABELS = {
    "guard": ("Atlas treasury · ExecutionGuard", "treasury"),
    "governor": ("Atlas Governor", "contract"),
    "registry": ("ProposalRegistry", "contract"),
    "usdc": ("mUSDC token (demo)", "contract"),
    "atlas": ("ATLAS governance token (demo)", "contract"),
    "fee_vault": ("FeeVault proxy", "contract"),
    "proxy_admin": ("FeeVault ProxyAdmin", "contract"),
    "fee_vault_v1": ("FeeVault v1 implementation", "contract"),
    "fee_vault_v2": ("FeeVaultV2 implementation (reviewed)", "contract"),
    "fee_vault_v2r": ("FeeVault v2 implementation (re-deployed)", "contract"),
    "legacy_guard": ("ExecutionGuard (legacy deployment)", "contract"),
}


@dataclass
class Deployment:
    chain_id: int
    genesis_hash: str
    deployed_block: int
    contracts: dict[str, str]
    accounts: dict[str, str]
    review_window_blocks: int
    voting_delay_blocks: int
    voting_period_blocks: int
    quorum_percent: int
    seeded: bool = False
    extra: dict[str, Any] = field(default_factory=dict)

    def c(self, name: str) -> str:
        return self.contracts[name]

    def a(self, role: str) -> str:
        return self.accounts[role]

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Deployment:
        return cls(**data)


class Runtime:
    def __init__(self) -> None:
        self.chain = ChainClient(get_settings().rpc_url)
        self.deployment: Deployment | None = None
        self.sentinel = None
        self.state: dict[str, Any] = {"phase": "starting", "message": "Starting up", "error": None}

    def require_deployment(self) -> Deployment:
        if self.deployment is None:
            from .errors import ServiceUnavailable

            raise ServiceUnavailable(
                "chain_unavailable",
                "The local demo chain is not deployed yet. Start the Hardhat node (npm run dev) and wait for seeding.",
            )
        return self.deployment

    def set_state(self, phase: str, message: str, error: str | None = None) -> None:
        self.state = {"phase": phase, "message": message, "error": error}


runtime = Runtime()


def load_deployment(db: Session) -> Deployment | None:
    row = db.get(KeyValue, "deployment")
    return Deployment.from_json(row.value) if row else None


def save_deployment(db: Session, deployment: Deployment) -> None:
    row = db.get(KeyValue, "deployment")
    if row:
        row.value = deployment.to_json()
    else:
        db.add(KeyValue(key="deployment", value=deployment.to_json()))
