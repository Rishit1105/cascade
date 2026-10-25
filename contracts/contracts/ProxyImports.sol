// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Pulls OpenZeppelin proxy contracts into compilation so their artifacts can be exported
// to the backend, which deploys the FeeVault behind a TransparentUpgradeableProxy.
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
