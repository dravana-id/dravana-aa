// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/* solhint-disable reason-string */

import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/interfaces/UserOperation.sol";

import "./BasePaymaster.sol";

/**
 * @title DravanaPaymaster
 * @notice Optional gas sponsorship: whitelist-based; compatible with ERC-4337 EntryPoint.
 */
contract DravanaPaymaster is BasePaymaster {
    mapping(address => bool) public whitelist;

    constructor(IEntryPoint _entryPoint, address initialOwner) BasePaymaster(_entryPoint) {
        require(initialOwner != address(0), "OWNER_ZERO");
        _transferOwnership(initialOwner);
    }

    function setWhitelisted(address account, bool allowed) external onlyOwner {
        whitelist[account] = allowed;
    }

    function _validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        (maxCost);
        require(whitelist[userOp.sender], "NOT_SPONSORED");
        return ("", 0);
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost) internal override {
        (mode, context, actualGasCost);
    }
}
