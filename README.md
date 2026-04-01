# dravana-aa

KYT-enforced ERC-4337 smart account (Dravana-AA): EIP-712 `DravanaNetraKYT` bindings, strict single-use KYT nonces, `bridgeOut`-only execution.

## Layout

- `contracts/DravanaSmartWallet.sol` — account + embedded policy enforcement
- `contracts/DravanaAccountFactory.sol` — CREATE2 factory (now exposes `DravanaSmartWalletFactory`)
- `contracts/libraries/KytBindingLib.sol` — EIP-712 type hash
- `contracts/interfaces/IBridgeOut.sol` — reference `bridgeOut` surface
- `contracts/DravanaPolicyEngine.sol` — on-chain policy validation module
- `contracts/mocks/MockBridge.sol` — tests

## Commands

```bash
npm install
npx hardhat compile
npx hardhat test
```

Forge (optional): `forge build` with `foundry.toml` and `libs = ["node_modules"]`.

## EIP-712

Domain: `name=DravanaNetraKYT`, `version=1`, `chainId=<execution chain>`, `verifyingContract=<account proxy address>`.

## UserOp `callData`

ABI-encodes `executeKytBridgeOut(bridge, amount, binding, kytSignature, bridgeOutCalldata)` where `bridgeOutCalldata` is strictly `bridgeOut(address,uint256)` to the final recipient.
