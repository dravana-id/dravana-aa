// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

/* solhint-disable reason-string */

import "@account-abstraction/contracts/core/BaseAccount.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import "./libraries/KytBindingLib.sol";

/**
 * @title DravanaAccount
 * @notice KYT-enforced ERC-4337 account: EIP-712 binding, single-use KYT nonce, bridgeOut-only execution.
 */
contract DravanaAccount is BaseAccount, EIP712, Initializable, UUPSUpgradeable {
    using ECDSA for bytes32;

    /// @notice Off-chain KYT signer (must match binding signature).
    address public immutable kytSigner;

    IEntryPoint private immutable _entryPoint;

    /// @notice KYT binding nonces (strict single-use).
    mapping(uint256 => bool) public usedNonce;

    struct KytBinding {
        address sender;
        address destination;
        uint256 destinationChain;
        uint256 amount;
        uint256 expiry;
        uint256 nonce;
    }

    /// @dev Canonical bridgeOut(recipient, amount) selector — pass-through constraint.
    bytes4 public constant BRIDGE_OUT_SELECTOR = bytes4(keccak256("bridgeOut(address,uint256)"));

    /// @dev ABI: executeKytBridgeOut(address,uint256,(address,address,uint256,uint256,uint256,uint256),bytes,bytes)
    bytes4 public constant EXECUTE_KYT_BRIDGE_OUT_SELECTOR =
        bytes4(keccak256("executeKytBridgeOut(address,uint256,(address,address,uint256,uint256,uint256,uint256),bytes,bytes)"));

    address public owner;

    event DravanaAccountInitialized(IEntryPoint indexed entryPoint, address indexed owner, address indexed kytSigner);

    event KytBridgeExecuted(uint256 indexed kytNonce, uint256 amount, bytes32 kytSigDigest);

    constructor(IEntryPoint anEntryPoint, address _kytSigner) EIP712("DravanaNetraKYT", "1") {
        require(_kytSigner != address(0), "KYT_SIGNER_ZERO");
        _entryPoint = anEntryPoint;
        kytSigner = _kytSigner;
        _disableInitializers();
    }

    function initialize(address anOwner) external initializer {
        require(anOwner != address(0), "OWNER_ZERO");
        owner = anOwner;
        emit DravanaAccountInitialized(_entryPoint, anOwner, kytSigner);
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    /**
     * @notice ERC-4337 validation: KYT + bridge rules, then owner signature on `userOpHash`.
     */
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256 validationData) {
        _requireFromEntryPoint();
        _validateKytBridge(userOp);
        validationData = _validateSignature(userOp, userOpHash);
        _validateNonce(userOp.nonce);
        _payPrefund(missingAccountFunds);
    }

    /**
     * @param destination Bridge contract to call with `bridgeOutCalldata`.
     * @param amount Must match `binding.amount` and `bridgeOut` args.
     */
    function executeKytBridgeOut(
        address destination,
        uint256 amount,
        KytBinding calldata binding,
        bytes calldata kytSignature,
        bytes calldata bridgeOutCalldata
    ) external {
        _requireFromEntryPoint();
        emit KytBridgeExecuted(binding.nonce, amount, keccak256(kytSignature));
        (bool success, bytes memory ret) = destination.call(bridgeOutCalldata);
        if (!success) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _validateKytBridge(UserOperation calldata userOp) internal {
        bytes calldata cd = userOp.callData;
        require(cd.length >= 4, "NO_CALLDATA");
        require(bytes4(cd[0:4]) == EXECUTE_KYT_BRIDGE_OUT_SELECTOR, "INVALID_SELECTOR");

        (
            address bridge,
            uint256 amount,
            KytBinding memory binding,
            bytes memory kytSig,
            bytes memory bridgeOutCalldata
        ) = abi.decode(cd[4:], (address, uint256, KytBinding, bytes, bytes));

        require(binding.destination != address(0), "INVALID_DEST");
        require(binding.amount > 0, "INVALID_AMOUNT");
        require(binding.sender == owner, "INVALID_SENDER");
        require(binding.destinationChain == block.chainid, "CHAIN_MISMATCH");

        require(_verifyKyt(binding, kytSig), "INVALID_KYT");
        require(!usedNonce[binding.nonce], "NONCE_USED");
        require(block.timestamp <= binding.expiry, "EXPIRED");
        require(binding.amount == amount, "AMOUNT_MISMATCH");
        require(bridgeOutCalldata.length >= 4 + 64, "ONLY_BRIDGE_OUT");
        require(_readBytes4Mem(bridgeOutCalldata, 0) == BRIDGE_OUT_SELECTOR, "ONLY_BRIDGE_OUT");

        (address recipient, uint256 bridgeAmount) =
            abi.decode(_sliceMem(bridgeOutCalldata, 4, bridgeOutCalldata.length - 4), (address, uint256));
        require(recipient == binding.destination && bridgeAmount == binding.amount, "DEST_MISMATCH");
        require(bridge != address(0), "BRIDGE_ZERO");

        usedNonce[binding.nonce] = true;
    }

    function _readBytes4Mem(bytes memory data, uint256 start) internal pure returns (bytes4 r) {
        require(data.length >= start + 4, "SHORT");
        assembly {
            r := mload(add(add(data, 32), start))
        }
        r = bytes4(r);
    }

    /// @dev Gas-optimized slice: full 32-byte words in assembly, remainder byte-wise (max 31).
    function _sliceMem(bytes memory src, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        require(start + len <= src.length, "SLICE_OOB");
        out = new bytes(len);
        uint256 fullWords = len / 32;
        uint256 rem = len % 32;
        assembly {
            let srcPos := add(add(src, 0x20), start)
            let dstPos := add(out, 0x20)
            let w := 0
            for {} lt(w, fullWords) { w := add(w, 1) } {
                mstore(add(dstPos, mul(w, 0x20)), mload(add(srcPos, mul(w, 0x20))))
            }
        }
        unchecked {
            uint256 base = start + fullWords * 32;
            for (uint256 i = 0; i < rem; i++) {
                out[fullWords * 32 + i] = src[base + i];
            }
        }
    }

    function _verifyKyt(KytBinding memory binding, bytes memory signature) internal view returns (bool) {
        bytes32 structHash = keccak256(
            abi.encode(
                KytBindingLib.KYT_TYPEHASH,
                binding.sender,
                binding.destination,
                binding.destinationChain,
                binding.amount,
                binding.expiry,
                binding.nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        return signer == kytSigner;
    }

    function _validateSignature(UserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256 validationData)
    {
        bytes32 hash = userOpHash.toEthSignedMessageHash();
        if (owner != hash.recover(userOp.signature)) return SIG_VALIDATION_FAILED;
        return 0;
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        (newImplementation);
        require(msg.sender == owner, "only owner");
    }

    receive() external payable {}
}
