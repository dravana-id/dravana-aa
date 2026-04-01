// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/**
 * @title DravanaPolicyEngine
 * @notice On-chain policy validation module used by SmartWallet
 *
 * @dev This contract MUST NOT execute transactions. It only validates policy rules and
 *      reverts on violations.
 */
contract DravanaPolicyEngine {
    error AmountTooHigh(uint256 amount, uint256 maxAmountPerTx);
    error DestinationZero();
    error DestinationBlocked(address destination);
    error DestinationNotAllowed(address destination);
    error TokenNotAllowed(address token);

    uint256 public immutable maxAmountPerTx;

    bool public immutable enforceAllowedTokens;
    bool public immutable enforceAllowedDestinations;

    mapping(address => bool) public allowedTokens;
    mapping(address => bool) public allowedDestinations;
    mapping(address => bool) public blockedDestinations;

    /**
     * @param _maxAmountPerTx Mirrors `OPC_MAX_AMOUNT_PER_TX` from `OPC_SIMULATION`.
     * @param _allowedTokens Mirrors `OPC_ALLOWED_TOKENS` from `OPC_SIMULATION`.
     * @param _allowedDestinations Mirrors `OPC_ALLOWED_DESTINATIONS` from `OPC_SIMULATION`.
     * @param _blockedAddresses Mirrors `OPC_BLOCKED_ADDRESSES` from `OPC_SIMULATION`.
     */
    constructor(
        uint256 _maxAmountPerTx,
        address[] memory _allowedTokens,
        address[] memory _allowedDestinations,
        address[] memory _blockedAddresses
    ) {
        maxAmountPerTx = _maxAmountPerTx;

        enforceAllowedTokens = _allowedTokens.length > 0;
        enforceAllowedDestinations = _allowedDestinations.length > 0;

        for (uint256 i = 0; i < _allowedTokens.length; i++) {
            allowedTokens[_allowedTokens[i]] = true;
        }
        for (uint256 i = 0; i < _allowedDestinations.length; i++) {
            allowedDestinations[_allowedDestinations[i]] = true;
        }
        for (uint256 i = 0; i < _blockedAddresses.length; i++) {
            blockedDestinations[_blockedAddresses[i]] = true;
        }
    }

    /**
     * @notice Validate policy rules.
     * @dev MUST revert on violation.
     * @param destination Mirrors `destination` in `OPC_SIMULATION`.
     * @param amount Mirrors `amount` in `OPC_SIMULATION`.
     * @param token Mirrors `token` in `OPC_SIMULATION`.
     */
    function validateOpc(address destination, uint256 amount, address token) external view {
        if (destination == address(0)) revert DestinationZero();
        if (amount > maxAmountPerTx) revert AmountTooHigh(amount, maxAmountPerTx);
        if (blockedDestinations[destination]) revert DestinationBlocked(destination);

        if (enforceAllowedDestinations && !allowedDestinations[destination]) {
            revert DestinationNotAllowed(destination);
        }

        // Match `OPC_SIMULATION` behavior: only enforce allowed_tokens when a token is provided.
        if (token != address(0) && enforceAllowedTokens && !allowedTokens[token]) {
            revert TokenNotAllowed(token);
        }
    }
}

