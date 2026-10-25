// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title ExecutionGuard
/// @notice Treasury executor that will only run the exact action manifest approved by governance.
/// @dev The approval is an EIP-712 digest over (chainId, guard address, proposalKey, version, actions),
///      so a manifest approved for another chain, another guard, another version or with any changed
///      target / value / calldata / operation cannot execute. Demo contract for a local chain; not audited.
contract ExecutionGuard is AccessControl, ReentrancyGuard, EIP712 {
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    bytes32 public constant ACTION_TYPEHASH =
        keccak256("Action(address target,uint256 value,bytes data,uint8 operation)");
    bytes32 public constant MANIFEST_TYPEHASH = keccak256(
        "Manifest(bytes32 proposalKey,uint64 version,Action[] actions)Action(address target,uint256 value,bytes data,uint8 operation)"
    );

    /// @notice Only plain CALLs are executable. DELEGATECALL would let a payload rewrite guard storage.
    uint8 public constant OPERATION_CALL = 0;

    enum Status {
        None,
        Approved,
        Executed,
        Halted
    }

    struct Action {
        address target;
        uint256 value;
        bytes data;
        uint8 operation;
    }

    struct Approval {
        bytes32 manifestHash;
        uint64 version;
        uint64 approvedAtBlock;
        uint64 executableAtBlock;
        Status status;
        bytes32 haltReason;
    }

    /// @notice Blocks between approval and earliest execution; the window in which a guardian may halt.
    uint64 public immutable reviewWindowBlocks;

    mapping(bytes32 proposalKey => Approval) private _approvals;

    event ManifestApproved(
        bytes32 indexed proposalKey, uint64 indexed version, bytes32 manifestHash, uint64 executableAtBlock
    );
    event ManifestExecuted(
        bytes32 indexed proposalKey,
        uint64 indexed version,
        bytes32 manifestHash,
        address indexed executor,
        uint256 actionCount
    );
    event ProposalHalted(
        bytes32 indexed proposalKey,
        uint64 indexed version,
        bytes32 manifestHash,
        address indexed guardian,
        bytes32 reasonHash
    );

    error NotApproved(bytes32 proposalKey);
    error AlreadyExecuted(bytes32 proposalKey);
    error ProposalIsHalted(bytes32 proposalKey, bytes32 reasonHash);
    error ReviewWindowActive(uint64 executableAtBlock, uint64 currentBlock);
    error StaleVersion(uint64 approvedVersion, uint64 submittedVersion);
    error ManifestMismatch(bytes32 approvedHash, bytes32 submittedHash);
    error EmptyManifest();
    error UnsupportedOperation(uint256 index, uint8 operation);
    error ActionFailed(uint256 index, bytes returndata);
    error InvalidManifestHash();
    error NotHaltable(bytes32 proposalKey, Status status);

    constructor(address governor, address executor, address guardian, uint64 reviewWindow)
        EIP712("DAOGuard ExecutionGuard", "1")
    {
        _grantRole(DEFAULT_ADMIN_ROLE, governor);
        _grantRole(GOVERNOR_ROLE, governor);
        _grantRole(EXECUTOR_ROLE, executor);
        _grantRole(GUARDIAN_ROLE, guardian);
        reviewWindowBlocks = reviewWindow;
    }

    /// @notice Record governance approval of an exact manifest digest.
    /// @dev A halted or approved proposal can only be re-approved with a strictly newer version,
    ///      so a guardian halt cannot be bypassed by re-approving the same payload.
    function approveManifest(bytes32 proposalKey, uint64 version, bytes32 manifestHash)
        external
        onlyRole(GOVERNOR_ROLE)
    {
        if (manifestHash == bytes32(0)) revert InvalidManifestHash();
        Approval storage current = _approvals[proposalKey];
        if (current.status == Status.Executed) revert AlreadyExecuted(proposalKey);
        if (current.status != Status.None && version <= current.version) {
            revert StaleVersion(current.version, version);
        }
        uint64 executableAt = uint64(block.number) + reviewWindowBlocks;
        _approvals[proposalKey] =
            Approval(manifestHash, version, uint64(block.number), executableAt, Status.Approved, bytes32(0));
        emit ManifestApproved(proposalKey, version, manifestHash, executableAt);
    }

    /// @notice Guardian veto of an approved, not yet executed manifest. Guardians can only block;
    ///         they cannot approve, alter or execute anything.
    function halt(bytes32 proposalKey, bytes32 reasonHash) external onlyRole(GUARDIAN_ROLE) {
        Approval storage a = _approvals[proposalKey];
        if (a.status != Status.Approved) revert NotHaltable(proposalKey, a.status);
        a.status = Status.Halted;
        a.haltReason = reasonHash;
        emit ProposalHalted(proposalKey, a.version, a.manifestHash, msg.sender, reasonHash);
    }

    /// @notice Execute the approved manifest. Reverts (moving nothing) unless every action matches.
    function execute(bytes32 proposalKey, uint64 version, Action[] calldata actions)
        external
        payable
        onlyRole(EXECUTOR_ROLE)
        nonReentrant
        returns (bytes[] memory results)
    {
        Approval storage a = _approvals[proposalKey];
        bytes32 submitted = _checkExecutable(a, proposalKey, version, actions);
        a.status = Status.Executed;

        results = new bytes[](actions.length);
        for (uint256 i = 0; i < actions.length; ++i) {
            (bool ok, bytes memory ret) = actions[i].target.call{value: actions[i].value}(actions[i].data);
            if (!ok) revert ActionFailed(i, ret);
            results[i] = ret;
        }
        emit ManifestExecuted(proposalKey, version, submitted, msg.sender, actions.length);
    }

    /// @notice Dry-run of every execute() check. Reverts with the same custom error execute() would.
    function preflight(bytes32 proposalKey, uint64 version, Action[] calldata actions)
        external
        view
        returns (bytes32 submittedHash)
    {
        return _checkExecutable(_approvals[proposalKey], proposalKey, version, actions);
    }

    function hashManifest(bytes32 proposalKey, uint64 version, Action[] calldata actions)
        public
        view
        returns (bytes32)
    {
        bytes32[] memory actionHashes = new bytes32[](actions.length);
        for (uint256 i = 0; i < actions.length; ++i) {
            actionHashes[i] = keccak256(
                abi.encode(
                    ACTION_TYPEHASH,
                    actions[i].target,
                    actions[i].value,
                    keccak256(actions[i].data),
                    actions[i].operation
                )
            );
        }
        bytes32 structHash =
            keccak256(abi.encode(MANIFEST_TYPEHASH, proposalKey, version, keccak256(abi.encodePacked(actionHashes))));
        return _hashTypedDataV4(structHash);
    }

    function approvalOf(bytes32 proposalKey) external view returns (Approval memory) {
        return _approvals[proposalKey];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    receive() external payable {}

    function _checkExecutable(Approval storage a, bytes32 proposalKey, uint64 version, Action[] calldata actions)
        private
        view
        returns (bytes32 submitted)
    {
        if (a.status == Status.None) revert NotApproved(proposalKey);
        if (a.status == Status.Executed) revert AlreadyExecuted(proposalKey);
        if (a.status == Status.Halted) revert ProposalIsHalted(proposalKey, a.haltReason);
        if (block.number < a.executableAtBlock) {
            revert ReviewWindowActive(a.executableAtBlock, uint64(block.number));
        }
        if (actions.length == 0) revert EmptyManifest();
        for (uint256 i = 0; i < actions.length; ++i) {
            if (actions[i].operation != OPERATION_CALL) revert UnsupportedOperation(i, actions[i].operation);
        }
        if (version != a.version) revert StaleVersion(a.version, version);
        submitted = hashManifest(proposalKey, version, actions);
        if (submitted != a.manifestHash) revert ManifestMismatch(a.manifestHash, submitted);
    }
}
