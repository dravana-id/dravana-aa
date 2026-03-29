import { expect } from "chai";
import { ethers, network } from "hardhat";
import { BigNumberish, Wallet } from "ethers";

const iface = new ethers.utils.Interface([
  "function executeKytBridgeOut(address,uint256,(address,address,uint256,uint256,uint256,uint256),bytes,bytes)",
]);

type KytBinding = {
  sender: string;
  destination: string;
  destinationChain: BigNumberish;
  amount: BigNumberish;
  expiry: BigNumberish;
  nonce: BigNumberish;
};

async function signKyt(
  signer: Wallet,
  verifyingContract: string,
  chainId: number,
  binding: KytBinding
) {
  const domain = {
    name: "DravanaNetraKYT",
    version: "1",
    chainId,
    verifyingContract,
  };
  const types = {
    KytBinding: [
      { name: "sender", type: "address" },
      { name: "destination", type: "address" },
      { name: "destinationChain", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const value = {
    sender: binding.sender,
    destination: binding.destination,
    destinationChain: binding.destinationChain,
    amount: binding.amount,
    expiry: binding.expiry,
    nonce: binding.nonce,
  };
  return signer._signTypedData(domain, types, value);
}

function encodeExecute(
  bridge: string,
  amount: BigNumberish,
  binding: KytBinding,
  kytSig: string,
  bridgeOutCalldata: string
) {
  return iface.encodeFunctionData("executeKytBridgeOut", [
    bridge,
    amount,
    [
      binding.sender,
      binding.destination,
      binding.destinationChain,
      binding.amount,
      binding.expiry,
      binding.nonce,
    ],
    kytSig,
    bridgeOutCalldata,
  ]);
}

async function impersonateEntryPoint(entryPoint: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [entryPoint],
  });
  await network.provider.send("hardhat_setBalance", [entryPoint, "0xffffffffffffffffffffffffffffffff"]);
  return ethers.provider.getSigner(entryPoint);
}

describe("DravanaAccount KYT + bridgeOut", () => {
  let entryPoint: { address: string; getUserOpHash: (op: unknown) => Promise<string> };
  let factory: { getAddress: (o: string, s: number) => Promise<string> };
  let account: { address: string; connect: (s: ethers.Signer) => { validateUserOp: (...a: unknown[]) => Promise<ethers.ContractTransaction> } };
  let bridge: { address: string; interface: ethers.utils.Interface };
  let owner: Wallet;
  let kytSigner: Wallet;
  let wrongSigner: Wallet;
  let recipient: string;
  const salt = 42;
  let chainId: number;

  beforeEach(async () => {
    recipient = ethers.Wallet.createRandom().address;
    [owner, kytSigner, wrongSigner] = Array.from({ length: 3 }, () =>
      ethers.Wallet.createRandom().connect(ethers.provider)
    );
    await network.provider.send("hardhat_setBalance", [owner.address, ethers.utils.parseEther("10").toHexString()]);
    await network.provider.send("hardhat_setBalance", [kytSigner.address, ethers.utils.parseEther("1").toHexString()]);

    const EntryPointF = await ethers.getContractFactory("EntryPoint");
    entryPoint = (await EntryPointF.deploy()) as typeof entryPoint;

    const FactoryF = await ethers.getContractFactory("DravanaAccountFactory");
    factory = (await FactoryF.deploy(entryPoint.address, kytSigner.address)) as typeof factory;

    await factory.createAccount(owner.address, salt);
    const addr = await factory.getAddress(owner.address, salt);
    account = (await ethers.getContractAt("DravanaAccount", addr)) as typeof account;

    const BridgeF = await ethers.getContractFactory("MockBridge");
    bridge = (await BridgeF.deploy()) as typeof bridge;

    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  function buildBinding(overrides: Partial<KytBinding> = {}): KytBinding {
    const amount = ethers.utils.parseEther("1");
    return {
      sender: account.address,
      destination: recipient,
      destinationChain: chainId,
      amount,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      nonce: 777,
      ...overrides,
    };
  }

  async function buildUserOp(callData: string, ownerWallet: Wallet = owner) {
    const nonce = await entryPoint.getNonce(account.address, 0);
    const userOpStruct = {
      sender: account.address,
      nonce,
      initCode: "0x",
      callData,
      callGasLimit: 500_000,
      verificationGasLimit: 2_000_000,
      preVerificationGas: 100_000,
      maxFeePerGas: 1,
      maxPriorityFeePerGas: 1,
      paymasterAndData: "0x",
      signature: "0x",
    };
    const userOpHash = await entryPoint.getUserOpHash(userOpStruct);
    const signature = await ownerWallet.signMessage(ethers.utils.arrayify(userOpHash));
    return { ...userOpStruct, signature };
  }

  it("valid flow: validateUserOp succeeds", async () => {
    const binding = buildBinding({ nonce: 1 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    const tx = await account.connect(epSigner).validateUserOp(userOp, userOpHash, 0);
    const receipt = await tx.wait();
    expect(receipt.status).to.equal(1);
  });

  it("reverts DEST_MISMATCH when bridge recipient != binding.destination", async () => {
    const binding = buildBinding({ nonce: 2 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [
      ethers.Wallet.createRandom().address,
      binding.amount,
    ]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("DEST_MISMATCH");
  });

  it("reverts NONCE_USED on replay", async () => {
    const binding = buildBinding({ nonce: 999 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await account.connect(epSigner).validateUserOp(userOp, userOpHash, 0);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("NONCE_USED");
  });

  it("reverts EXPIRED", async () => {
    const binding = buildBinding({ expiry: Math.floor(Date.now() / 1000) - 10, nonce: 3 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("EXPIRED");
  });

  it("reverts INVALID_KYT with wrong signer", async () => {
    const binding = buildBinding({ nonce: 4 });
    const kytSig = await signKyt(wrongSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_KYT");
  });

  it("reverts ONLY_BRIDGE_OUT for non-bridge selector", async () => {
    const binding = buildBinding({ nonce: 5 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("notBridgeOut", []);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("ONLY_BRIDGE_OUT");
  });
});
