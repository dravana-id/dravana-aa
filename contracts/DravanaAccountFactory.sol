// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

import "./DravanaAccount.sol";

/**
 * @title DravanaAccountFactory
 * @notice CREATE2 counterfactual deployment; implementation immutables include `kytSigner` for EIP-712 domain (`verifyingContract` = proxy).
 */
contract DravanaAccountFactory {
    DravanaAccount public immutable accountImplementation;

    constructor(IEntryPoint entryPoint, address kytSigner) {
        accountImplementation = new DravanaAccount(entryPoint, kytSigner);
    }

    /**
     * @notice Deploy account proxy or return existing. Address stable for `getAddress`.
     */
    function createAccount(address anOwner, uint256 salt) public returns (DravanaAccount ret) {
        address addr = getAddress(anOwner, salt);
        uint256 codeSize = addr.code.length;
        if (codeSize > 0) {
            return DravanaAccount(payable(addr));
        }
        ret = DravanaAccount(
            payable(
                new ERC1967Proxy{salt: bytes32(salt)}(
                    address(accountImplementation),
                    abi.encodeCall(DravanaAccount.initialize, (anOwner))
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
                            address(accountImplementation),
                            abi.encodeCall(DravanaAccount.initialize, (anOwner))
                        )
                    )
                )
            );
    }
}
