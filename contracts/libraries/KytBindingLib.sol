// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/**
 * @dev KYT EIP-712 type hash (must match off-chain Dravana Netra binding builder).
 */
library KytBindingLib {
    bytes32 internal constant KYT_TYPEHASH = keccak256(
        "KytBinding(address sender,address destination,uint256 destinationChain,uint256 amount,uint256 expiry,uint256 nonce)"
    );
}
