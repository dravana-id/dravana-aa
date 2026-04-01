// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import "./DravanaSmartWallet.sol";

/**
 * @title DravanaSmartWalletFactory
 * @notice CREATE2 counterfactual deployment; implementation immutables include `kytSigner` and `opcPolicyEngine` for on-chain policy validation.
 */
contract DravanaSmartWalletFactory {
    DravanaSmartWallet public immutable smartWalletImplementation;

    constructor(IEntryPoint entryPoint, address kytSigner, address opcPolicyEngine) {
        smartWalletImplementation = new DravanaSmartWallet(entryPoint, kytSigner, opcPolicyEngine);
    }

    /**
     * @notice Deploy account proxy or return existing. Address stable for `getAddress`.
     */
    function createAccount(address anOwner, uint256 salt) public returns (DravanaSmartWallet ret) {
        address addr = getAddress(anOwner, salt);
        uint256 codeSize = addr.code.length;
        if (codeSize > 0) {
            return DravanaSmartWallet(payable(addr));
        }
        ret = DravanaSmartWallet(
            payable(
                new ERC1967Proxy{salt: bytes32(salt)}(
                    address(smartWalletImplementation),
                    abi.encodeCall(DravanaSmartWallet.initialize, (anOwner))
                )
            )
        );
    }

    /**
     * @dev Counterfactual proxy address (CREATE2).
     */
    function getAddress(address anOwner, uint256 salt) public view returns (address) {
        return
            Create2.computeAddress(
                bytes32(salt),
                keccak256(
                    abi.encodePacked(
                        type(ERC1967Proxy).creationCode,
                        abi.encode(
                            address(smartWalletImplementation),
                            abi.encodeCall(DravanaSmartWallet.initialize, (anOwner))
                        )
                    )
                )
            );
    }
}
