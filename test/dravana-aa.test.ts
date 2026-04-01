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

describe("Dravana-AA (account + paymaster)", () => {
  let entryPoint: {
    address: string;
    getUserOpHash: (op: unknown) => Promise<string>;
    getNonce: (a: string, n: number) => Promise<ethers.BigNumber>;
  };
  let factory: { getAddress: (o: string, s: number) => Promise<string> };
  let account: { address: string; connect: (s: ethers.Signer) => { validateUserOp: (...a: unknown[]) => Promise<ethers.ContractTransaction> } };
  let bridge: { address: string; interface: ethers.utils.Interface };
  let owner: Wallet;
  let kytSigner: Wallet;
  let wrongSigner: Wallet;
  let recipient: string;
  const salt = 42;
  let chainId: number;
  let opcPolicyEngine: { address: string };

  beforeEach(async () => {
    recipient = ethers.Wallet.createRandom().address;
    [owner, kytSigner, wrongSigner] = Array.from({ length: 3 }, () =>
      ethers.Wallet.createRandom().connect(ethers.provider)
    );
    await network.provider.send("hardhat_setBalance", [owner.address, ethers.utils.parseEther("10").toHexString()]);
    await network.provider.send("hardhat_setBalance", [kytSigner.address, ethers.utils.parseEther("1").toHexString()]);

    const EntryPointF = await ethers.getContractFactory("EntryPoint");
    entryPoint = (await EntryPointF.deploy()) as typeof entryPoint;

    const PolicyEngineF = await ethers.getContractFactory("DravanaPolicyEngine");
    opcPolicyEngine = (await PolicyEngineF.deploy(ethers.constants.MaxUint256, [], [], [])) as typeof opcPolicyEngine;

    const FactoryF = await ethers.getContractFactory("DravanaSmartWalletFactory");
    factory = (await FactoryF.deploy(entryPoint.address, kytSigner.address, opcPolicyEngine.address)) as typeof factory;

    await factory.createAccount(owner.address, salt);
    const addr = await factory.getAddress(owner.address, salt);
    account = (await ethers.getContractAt("DravanaSmartWallet", addr)) as typeof account;

    const BridgeF = await ethers.getContractFactory("MockBridge");
    bridge = (await BridgeF.deploy()) as typeof bridge;

    chainId = (await ethers.provider.getNetwork()).chainId;
  });

  /** KYT binding.sender must equal EOA owner (INVALID_SENDER if account.address). */
  function buildBinding(overrides: Partial<KytBinding> = {}): KytBinding {
    const amount = ethers.utils.parseEther("1");
    return {
      sender: owner.address,
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

  it("1. valid flow: validateUserOp succeeds", async () => {
    const binding = buildBinding({ nonce: 1 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    const tx = await account.connect(epSigner).validateUserOp(userOp, userOpHash, 0);
    expect((await tx.wait()).status).to.equal(1);
  });

  it("2. INVALID_SENDER when binding.sender != owner", async () => {
    const binding = buildBinding({ nonce: 2, sender: account.address });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_SENDER");
  });

  it("3. CHAIN_MISMATCH when destinationChain != block.chainid", async () => {
    const binding = buildBinding({ nonce: 3, destinationChain: 999999 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("CHAIN_MISMATCH");
  });

  it("4. NONCE_USED on replay", async () => {
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

  it("5. DEST_MISMATCH wrong bridge recipient", async () => {
    const binding = buildBinding({ nonce: 5 });
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

  it("6. EXPIRED (past expiry + 5s grace)", async () => {
    const binding = buildBinding({ expiry: Math.floor(Date.now() / 1000) - 20, nonce: 6 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("EXPIRED");
  });

  it("7. INVALID_KYT wrong signer", async () => {
    const binding = buildBinding({ nonce: 7 });
    const kytSig = await signKyt(wrongSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_KYT");
  });

  it("8. ONLY_BRIDGE_OUT non-bridge selector", async () => {
    const binding = buildBinding({ nonce: 8 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("notBridgeOut", []);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("ONLY_BRIDGE_OUT");
  });

  it("9. INVALID_DEST zero destination", async () => {
    const binding = buildBinding({ nonce: 9, destination: ethers.constants.AddressZero });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [recipient, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_DEST_ZERO");
  });

  it("10. INVALID_AMOUNT zero amount", async () => {
    const binding = buildBinding({ nonce: 10, amount: 0 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, 0]);
    const callData = encodeExecute(bridge.address, 0, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_AMOUNT");
  });

  it("11. expiry grace: slightly past expiry still within +5s passes", async () => {
    const block = await ethers.provider.getBlock("latest");
    const ts = block.timestamp;
    const binding = buildBinding({ expiry: ts - 2, nonce: 11 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    const tx = await account.connect(epSigner).validateUserOp(userOp, userOpHash, 0);
    expect((await tx.wait()).status).to.equal(1);
  });

  it("12. INVALID_SENDER_ZERO", async () => {
    const binding = buildBinding({ nonce: 12, sender: ethers.constants.AddressZero });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [recipient, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith(
      "INVALID_SENDER_ZERO"
    );
  });

  it("13. INVALID_NONCE (zero)", async () => {
    const binding = buildBinding({ nonce: 0 });
    const kytSig = await signKyt(kytSigner, account.address, chainId, binding);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, kytSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_NONCE");
  });

  it("14. INVALID_SIG_LEN", async () => {
    const binding = buildBinding({ nonce: 14 });
    const badSig = "0x" + "00".repeat(64);
    const bridgeOutCalldata = bridge.interface.encodeFunctionData("bridgeOut", [binding.destination, binding.amount]);
    const callData = encodeExecute(bridge.address, binding.amount, binding, badSig, bridgeOutCalldata);
    const userOp = await buildUserOp(callData);
    const userOpHash = await entryPoint.getUserOpHash(userOp);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(account.connect(epSigner).validateUserOp(userOp, userOpHash, 0)).to.be.revertedWith("INVALID_SIG_LEN");
  });

  function buildPaymasterUserOp(pmAddress: string, overrides: Record<string, unknown> = {}) {
    return {
      sender: account.address,
      nonce: 0,
      initCode: "0x",
      callData: "0x01",
      callGasLimit: 100_000,
      verificationGasLimit: 100_000,
      preVerificationGas: 50_000,
      maxFeePerGas: 1,
      maxPriorityFeePerGas: 1,
      paymasterAndData: ethers.utils.hexConcat([pmAddress, "0x1234"]),
      signature: "0x",
      ...overrides,
    };
  }

  it("15. paymaster: whitelisted sender passes validatePaymasterUserOp", async () => {
    const PaymasterF = await ethers.getContractFactory("DravanaPaymaster");
    const pm = await PaymasterF.deploy(entryPoint.address, owner.address);
    await pm.connect(owner).setWhitelisted(account.address, true);

    const userOp = buildPaymasterUserOp(pm.address);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    const ret = await pm.connect(epSigner).callStatic.validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0);
    expect(ret.validationData).to.equal(0);
  });

  it("16. paymaster: non-whitelisted reverts NOT_SPONSORED", async () => {
    const PaymasterF = await ethers.getContractFactory("DravanaPaymaster");
    const pm = await PaymasterF.deploy(entryPoint.address, owner.address);
    await pm.connect(owner).setWhitelisted(account.address, false);

    const userOp = buildPaymasterUserOp(pm.address);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(
      pm.connect(epSigner).callStatic.validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0)
    ).to.be.revertedWith("NOT_SPONSORED");
  });

  it("17. paymaster: GAS_TOO_LOW", async () => {
    const PaymasterF = await ethers.getContractFactory("DravanaPaymaster");
    const pm = await PaymasterF.deploy(entryPoint.address, owner.address);
    await pm.connect(owner).setWhitelisted(account.address, true);

    const userOp = buildPaymasterUserOp(pm.address, { callGasLimit: 21000 });
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(
      pm.connect(epSigner).callStatic.validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0)
    ).to.be.revertedWith("GAS_TOO_LOW");
  });

  it("17b. paymaster: VERIFY_GAS_TOO_LOW", async () => {
    const PaymasterF = await ethers.getContractFactory("DravanaPaymaster");
    const pm = await PaymasterF.deploy(entryPoint.address, owner.address);
    await pm.connect(owner).setWhitelisted(account.address, true);

    const userOp = buildPaymasterUserOp(pm.address, { verificationGasLimit: 21000 });
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await expect(
      pm.connect(epSigner).callStatic.validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0)
    ).to.be.revertedWith("VERIFY_GAS_TOO_LOW");
  });

  it("18. paymaster: RATE_LIMIT on immediate second sponsorship", async () => {
    const PaymasterF = await ethers.getContractFactory("DravanaPaymaster");
    const pm = await PaymasterF.deploy(entryPoint.address, owner.address);
    await pm.connect(owner).setWhitelisted(account.address, true);

    const userOp = buildPaymasterUserOp(pm.address);
    const epSigner = await impersonateEntryPoint(entryPoint.address);
    await (await pm.connect(epSigner).validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0)).wait();
    await expect(
      pm.connect(epSigner).validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0)
    ).to.be.revertedWith("RATE_LIMIT");

    await network.provider.send("evm_increaseTime", [6]);
    await network.provider.send("evm_mine", []);
    const ret = await pm.connect(epSigner).callStatic.validatePaymasterUserOp(userOp, ethers.constants.HashZero, 0);
    expect(ret.validationData).to.equal(0);
  });

  it("19. paymaster: sponsor signature approves when not whitelisted", async () => {
    const sponsor = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.send("hardhat_setBalance", [sponsor.address, ethers.utils.parseEther("1").toHexString()]);

    const PaymasterF = await ethers.getContractFactory("DravanaPaymaster");
    const pm = await PaymasterF.deploy(entryPoint.address, owner.address);
    await pm.connect(owner).setWhitelisted(account.address, false);
    await pm.connect(owner).setSponsorSigner(sponsor.address);

    const userOp = buildPaymasterUserOp(pm.address);
    const userOpHash = ethers.utils.keccak256("0xabcd");
    const sponsorSig = await sponsor.signMessage(ethers.utils.arrayify(userOpHash));
    const paymasterAndData = ethers.utils.hexConcat([pm.address, sponsorSig]);

    const epSigner = await impersonateEntryPoint(entryPoint.address);
    const ret = await pm.connect(epSigner).callStatic.validatePaymasterUserOp(
      { ...userOp, paymasterAndData },
      userOpHash,
      0
    );
    expect(ret.validationData).to.equal(0);
  });
});
