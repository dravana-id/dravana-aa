// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/**
 * @dev Minimal bridge surface — only `bridgeOut` is allowed through DravanaSmartWallet.
 */
interface IBridgeOut {
    function bridgeOut(address recipient, uint256 amount) external;
}
