"""Deploy the demo contract system to the local node and label every address."""

from __future__ import annotations

import logging

from eth_utils import to_checksum_address
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import AddressLabel
from ..runtime import ACCOUNT_ROLES, CONTRACT_LABELS, Deployment
from .client import ChainClient

log = logging.getLogger("daoguard.deploy")
EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"


def deploy_all(chain: ChainClient) -> Deployment:
    settings = get_settings()
    accounts = chain.accounts()
    needed = max(r[1] for r in ACCOUNT_ROLES) + 1
    if len(accounts) < needed:
        raise RuntimeError(f"The node exposes {len(accounts)} accounts; DAOGuard needs {needed}. Start it with contracts/hardhat.config.js.")
    roles = {role: accounts[idx] for role, idx, *_ in ACCOUNT_ROLES}
    deployer = roles["deployer"]

    def deploy(name: str, args: list) -> str:
        address = chain.deploy(name, args, deployer).contract_address
        log.info("deployed %s at %s", name, address)
        return address

    usdc = deploy("MockUSDC", [deployer])
    atlas = deploy("AtlasToken", [deployer])
    governor = deploy("AtlasGovernor", [atlas, settings.voting_delay_blocks, settings.voting_period_blocks, settings.quorum_percent])
    guard = deploy("ExecutionGuard", [governor, roles["executor"], roles["sentinel"], settings.review_window_blocks])
    legacy_guard = deploy("ExecutionGuard", [deployer, roles["executor"], roles["sentinel"], settings.review_window_blocks])
    registry = deploy("ProposalRegistry", [deployer, roles["sentinel"]])
    v1 = deploy("FeeVault", [])
    v2 = deploy("FeeVaultV2", [])
    v2r = deploy("FeeVaultV2R", [roles["reconciler"]])
    vault_impl = chain.contract("FeeVault", v1)
    init = vault_impl.encode_abi("initialize", args=[usdc, guard, 30])
    proxy = deploy("TransparentUpgradeableProxy", [v1, guard, bytes.fromhex(init[2:])])
    admin_word = chain.get_storage(proxy, EIP1967_ADMIN_SLOT)
    proxy_admin = to_checksum_address("0x" + admin_word[-40:])

    return Deployment(
        chain_id=chain.chain_id,
        genesis_hash=chain.genesis_hash(),
        deployed_block=chain.block_number(),
        contracts={
            "usdc": usdc, "atlas": atlas, "governor": governor, "guard": guard, "legacy_guard": legacy_guard,
            "registry": registry, "fee_vault": proxy, "proxy_admin": proxy_admin,
            "fee_vault_v1": v1, "fee_vault_v2": v2, "fee_vault_v2r": v2r,
        },
        accounts=roles,
        review_window_blocks=settings.review_window_blocks,
        voting_delay_blocks=settings.voting_delay_blocks,
        voting_period_blocks=settings.voting_period_blocks,
        quorum_percent=settings.quorum_percent,
    )


def write_labels(db: Session, deployment: Deployment) -> None:
    for role, _idx, label, kind, description in ACCOUNT_ROLES:
        db.merge(AddressLabel(address=deployment.a(role), label=label, kind=kind, role=role, description=description, is_demo=True))
    for name, (label, kind) in CONTRACT_LABELS.items():
        if name in deployment.contracts:
            db.merge(AddressLabel(address=deployment.c(name), label=label, kind=kind, role=name, description="Demo contract on the local chain.", is_demo=True))
    db.commit()
