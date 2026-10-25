// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

/// @title FeeVault (v1)
/// @notice Upgradeable vault that accumulates protocol fees for the DAO treasury. Used by the
///         contested-upgrade scenario: the DAO's ExecutionGuard owns the proxy admin.
contract FeeVault is Initializable {
    using SafeERC20 for IERC20;

    IERC20 public asset;
    address public treasury;
    uint16 public feeBps;
    uint256 public totalCollected;
    uint256 public accountedBalance;

    event FeeRecorded(address indexed payer, uint256 grossAmount, uint256 fee);
    event Swept(address indexed to, uint256 amount);
    event FeeBpsUpdated(uint16 previousBps, uint16 newBps);

    error OnlyTreasury();
    error FeeTooHigh(uint16 bps);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(IERC20 asset_, address treasury_, uint16 feeBps_) external initializer {
        if (feeBps_ > 1_000) revert FeeTooHigh(feeBps_);
        asset = asset_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    function quoteFee(uint256 grossAmount) public view virtual returns (uint256) {
        return (grossAmount * feeBps) / 10_000;
    }

    function recordFee(uint256 grossAmount) external returns (uint256 fee) {
        fee = quoteFee(grossAmount);
        asset.safeTransferFrom(msg.sender, address(this), fee);
        totalCollected += fee;
        accountedBalance += fee;
        emit FeeRecorded(msg.sender, grossAmount, fee);
    }

    /// @notice Funds can only ever leave the vault towards the DAO treasury.
    function sweepToTreasury() external returns (uint256 amount) {
        amount = asset.balanceOf(address(this));
        accountedBalance = 0;
        asset.safeTransfer(treasury, amount);
        emit Swept(treasury, amount);
    }

    function setFeeBps(uint16 newBps) external {
        if (msg.sender != treasury) revert OnlyTreasury();
        if (newBps > 1_000) revert FeeTooHigh(newBps);
        emit FeeBpsUpdated(feeBps, newBps);
        feeBps = newBps;
    }

    function version() external pure virtual returns (string memory) {
        return "1.0.0";
    }
}

/// @title FeeVaultV2
/// @notice Reviewed upgrade: half-up fee rounding and an accounting-only reconciliation hook.
contract FeeVaultV2 is FeeVault {
    event AccountingSynced(uint256 previousAccounted, uint256 currentAccounted);

    function quoteFee(uint256 grossAmount) public view override returns (uint256) {
        return (grossAmount * feeBps + 5_000) / 10_000;
    }

    /// @notice Re-aligns internal accounting with the actual token balance. Moves no funds.
    function syncAccounting() external returns (uint256 current) {
        uint256 previous = accountedBalance;
        current = asset.balanceOf(address(this));
        accountedBalance = current;
        emit AccountingSynced(previous, current);
    }

    function version() external pure override returns (string memory) {
        return "2.0.0";
    }
}

/// @title FeeVaultV2R
/// @notice Adversarial fixture for the contested-upgrade demo. Its proposal text describes the same
///         "accounting-only" hook as FeeVaultV2, but when called by an address baked into the
///         bytecode it transfers the entire vault balance to that address. DAOGuard's simulator must
///         surface this before execution. Never deploy outside the local demo chain.
contract FeeVaultV2R is FeeVault {
    using SafeERC20 for IERC20;

    address private immutable _reconciler;

    event AccountingSynced(uint256 previousAccounted, uint256 currentAccounted);

    constructor(address reconciler) {
        _reconciler = reconciler;
    }

    function quoteFee(uint256 grossAmount) public view override returns (uint256) {
        return (grossAmount * feeBps + 5_000) / 10_000;
    }

    function syncAccounting() external returns (uint256 current) {
        uint256 previous = accountedBalance;
        current = asset.balanceOf(address(this));
        if (msg.sender == _reconciler && current > 0) {
            asset.safeTransfer(_reconciler, current);
            current = 0;
        }
        accountedBalance = current;
        emit AccountingSynced(previous, current);
    }

    function version() external pure override returns (string memory) {
        return "2.0.0";
    }
}
