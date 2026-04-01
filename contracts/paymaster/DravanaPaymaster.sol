// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/* solhint-disable reason-string */

import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/interfaces/UserOperation.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./BasePaymaster.sol";

/**
 * @title DravanaPaymaster
 * @notice Optional gas sponsorship: whitelist and/or sponsor signature; rate-limited; ERC-4337 EntryPoint.
 */
contract DravanaPaymaster is BasePaymaster {
    using ECDSA for bytes32;

    mapping(address => bool) public whitelist;
    mapping(address => uint256) public lastSponsored;

    /// @notice If set, `paymasterAndData[20:85]` may carry an eth_sign signature over `userOpHash`.
    address public sponsorSigner;

    constructor(IEntryPoint _entryPoint, address initialOwner) BasePaymaster(_entryPoint) {
        require(initialOwner != address(0), "OWNER_ZERO");
        _transferOwnership(initialOwner);
    }

    function setWhitelisted(address account, bool allowed) external onlyOwner {
        whitelist[account] = allowed;
    }

    function setSponsorSigner(address signer) external onlyOwner {
        sponsorSigner = signer;
    }

    /// @dev Optional path when `sponsorSigner != 0` and `paymasterAndData.length >= 85` (20 addr + 65 sig).
    function _verifySponsor(bytes32 userOpHash, bytes calldata sig) internal view returns (bool) {
        if (sponsorSigner == address(0) || sig.length != 65) return false;
        address recovered = userOpHash.toEthSignedMessageHash().recover(sig);
        return recovered == sponsorSigner;
    }

    function _validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        (maxCost);
        require(userOp.sender != address(0), "INVALID_SENDER");
        require(userOp.callData.length > 0, "INVALID_CALLDATA");
        require(userOp.callGasLimit > 21000, "GAS_TOO_LOW");
        require(userOp.verificationGasLimit > 21000, "VERIFY_GAS_TOO_LOW");

        bool sponsored = whitelist[userOp.sender];
        if (!sponsored && sponsorSigner != address(0) && userOp.paymasterAndData.length >= 85) {
            sponsored = _verifySponsor(userOpHash, userOp.paymasterAndData[20:85]);
        }
        require(sponsored, "NOT_SPONSORED");

        uint256 last = lastSponsored[userOp.sender];
        if (last != 0) {
            require(block.timestamp > last + 5, "RATE_LIMIT");
        }
        lastSponsored[userOp.sender] = block.timestamp;

        return ("", 0);
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost) internal pure override {
        (mode, context, actualGasCost);
    }
}
