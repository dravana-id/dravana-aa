// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

contract MockBridge {
    event BridgeOut(address indexed recipient, uint256 amount);

    function bridgeOut(address recipient, uint256 amount) external {
        emit BridgeOut(recipient, amount);
    }

    function notBridgeOut() external {}
}
