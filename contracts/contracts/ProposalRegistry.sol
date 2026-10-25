// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title ProposalRegistry
/// @notice Append-only, tamper-evident record of proposal versions, signed conflict-of-interest
///         disclosures, audit-ledger anchors and reviewer disputes.
/// @dev Only hashes are stored on-chain. Documents and disclosures stay off-chain; the hash proves
///      equality with what was committed, never that the content is true.
contract ProposalRegistry is AccessControl, EIP712 {
    bytes32 public constant COMMITTER_ROLE = keccak256("COMMITTER_ROLE");
    bytes32 public constant ANCHOR_ROLE = keccak256("ANCHOR_ROLE");

    bytes32 public constant DISCLOSURE_TYPEHASH =
        keccak256("Disclosure(bytes32 proposalKey,uint64 version,bytes32 contentHash,bytes32 disclosureHash)");

    struct VersionCommit {
        bytes32 contentHash;
        bytes32 manifestHash;
        bytes32 evidenceRoot;
        bytes32 disclosureHash;
        address proposer;
        address committer;
        uint64 blockNumber;
        uint64 timestamp;
    }

    mapping(bytes32 proposalKey => VersionCommit[]) private _versions;
    uint256 public anchorCount;

    event VersionCommitted(
        bytes32 indexed proposalKey,
        uint64 indexed version,
        bytes32 contentHash,
        bytes32 manifestHash,
        bytes32 evidenceRoot,
        bytes32 disclosureHash,
        address indexed proposer
    );
    event AuditAnchored(uint256 indexed anchorIndex, bytes32 ledgerHead, uint64 eventCount, address anchoredBy);
    event DisputeFiled(bytes32 indexed proposalKey, uint64 indexed version, address indexed filer, bytes32 disputeHash);

    error VersionOutOfOrder(uint64 expected, uint64 provided);
    error InvalidDisclosureSignature(address expected, address recovered);
    error UnknownVersion(bytes32 proposalKey, uint64 version);
    error EmptyHash();

    constructor(address admin, address committer) EIP712("DAOGuard ProposalRegistry", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMMITTER_ROLE, committer);
        _grantRole(ANCHOR_ROLE, committer);
    }

    /// @notice Commit the next version. The proposer must have signed (proposalKey, version,
    ///         contentHash, disclosureHash) so the disclosure is attributable to the proposer's key.
    function commitVersion(
        bytes32 proposalKey,
        uint64 version,
        bytes32 contentHash,
        bytes32 manifestHash,
        bytes32 evidenceRoot,
        bytes32 disclosureHash,
        address proposer,
        bytes calldata proposerSignature
    ) external onlyRole(COMMITTER_ROLE) {
        if (contentHash == bytes32(0) || disclosureHash == bytes32(0)) revert EmptyHash();
        uint64 expected = uint64(_versions[proposalKey].length) + 1;
        if (version != expected) revert VersionOutOfOrder(expected, version);

        bytes32 digest = disclosureDigest(proposalKey, version, contentHash, disclosureHash);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, proposerSignature);
        if (err != ECDSA.RecoverError.NoError || recovered != proposer) {
            revert InvalidDisclosureSignature(proposer, recovered);
        }

        _versions[proposalKey].push(
            VersionCommit({
                contentHash: contentHash,
                manifestHash: manifestHash,
                evidenceRoot: evidenceRoot,
                disclosureHash: disclosureHash,
                proposer: proposer,
                committer: msg.sender,
                blockNumber: uint64(block.number),
                timestamp: uint64(block.timestamp)
            })
        );
        emit VersionCommitted(proposalKey, version, contentHash, manifestHash, evidenceRoot, disclosureHash, proposer);
    }

    function anchorAudit(bytes32 ledgerHead, uint64 eventCount) external onlyRole(ANCHOR_ROLE) {
        if (ledgerHead == bytes32(0)) revert EmptyHash();
        emit AuditAnchored(anchorCount, ledgerHead, eventCount, msg.sender);
        anchorCount += 1;
    }

    /// @notice Anyone may file a dispute against a committed version; the statement stays off-chain.
    function fileDispute(bytes32 proposalKey, uint64 version, bytes32 disputeHash) external {
        if (disputeHash == bytes32(0)) revert EmptyHash();
        if (version == 0 || version > _versions[proposalKey].length) revert UnknownVersion(proposalKey, version);
        emit DisputeFiled(proposalKey, version, msg.sender, disputeHash);
    }

    function disclosureDigest(bytes32 proposalKey, uint64 version, bytes32 contentHash, bytes32 disclosureHash)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(DISCLOSURE_TYPEHASH, proposalKey, version, contentHash, disclosureHash))
        );
    }

    function versionCount(bytes32 proposalKey) external view returns (uint256) {
        return _versions[proposalKey].length;
    }

    function getVersion(bytes32 proposalKey, uint64 version) external view returns (VersionCommit memory) {
        if (version == 0 || version > _versions[proposalKey].length) revert UnknownVersion(proposalKey, version);
        return _versions[proposalKey][version - 1];
    }
}
