const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const KEY = ethers.id("GOV-042");
const REVIEW_WINDOW = 3n;

const MANIFEST_TYPES = {
  Manifest: [
    { name: "proposalKey", type: "bytes32" },
    { name: "version", type: "uint64" },
    { name: "actions", type: "Action[]" },
  ],
  Action: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
  ],
};

async function deployGuardFixture() {
  const [admin, governor, executor, guardian, walletA, walletB, attacker, outsider] = await ethers.getSigners();
  const usdc = await ethers.deployContract("MockUSDC", [admin.address]);
  const guard = await ethers.deployContract("ExecutionGuard", [
    governor.address,
    executor.address,
    guardian.address,
    REVIEW_WINDOW,
  ]);
  await usdc.mint(await guard.getAddress(), USDC(2_500_000));

  const transfer = (to, amount) => ({
    target: usdc.target,
    value: 0n,
    data: usdc.interface.encodeFunctionData("transfer", [to, amount]),
    operation: 0,
  });
  const approvedActions = [transfer(walletA.address, USDC(500_000))];

  async function approve(actions = approvedActions, version = 1) {
    const hash = await guard.hashManifest(KEY, version, actions);
    await guard.connect(governor).approveManifest(KEY, version, hash);
    await mine(Number(REVIEW_WINDOW));
    return hash;
  }

  return { admin, governor, executor, guardian, walletA, walletB, attacker, outsider, usdc, guard, transfer, approvedActions, approve };
}

describe("ExecutionGuard", function () {
  describe("manifest hashing", function () {
    it("matches the standard EIP-712 typed-data digest (chain + guard bound)", async function () {
      const { guard, approvedActions } = await loadFixture(deployGuardFixture);
      const { chainId } = await ethers.provider.getNetwork();
      const domain = { name: "DAOGuard ExecutionGuard", version: "1", chainId, verifyingContract: guard.target };
      const expected = ethers.TypedDataEncoder.hash(domain, MANIFEST_TYPES, {
        proposalKey: KEY,
        version: 1,
        actions: approvedActions,
      });
      expect(await guard.hashManifest(KEY, 1, approvedActions)).to.equal(expected);
    });
  });

  describe("accepted execution", function () {
    it("executes the exact approved manifest and moves the approved amount", async function () {
      const { guard, executor, usdc, walletA, approvedActions, approve } = await loadFixture(deployGuardFixture);
      const hash = await approve();
      await expect(guard.connect(executor).execute(KEY, 1, approvedActions))
        .to.emit(guard, "ManifestExecuted")
        .withArgs(KEY, 1, hash, executor.address, 1);
      expect(await usdc.balanceOf(walletA.address)).to.equal(USDC(500_000));
      expect(await usdc.balanceOf(guard.target)).to.equal(USDC(2_000_000));
      expect((await guard.approvalOf(KEY)).status).to.equal(2n); // Executed
    });
  });

  describe("rejected execution leaves balances untouched", function () {
    async function expectMismatch(ctx, actions) {
      const { guard, executor, usdc } = ctx;
      const before = await usdc.balanceOf(guard.target);
      await expect(guard.connect(executor).execute(KEY, 1, actions)).to.be.revertedWithCustomError(
        guard,
        "ManifestMismatch"
      );
      expect(await usdc.balanceOf(guard.target)).to.equal(before);
      expect((await guard.approvalOf(KEY)).status).to.equal(1n); // still Approved
    }

    it("rejects a changed recipient", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      await expectMismatch(ctx, [ctx.transfer(ctx.walletB.address, USDC(500_000))]);
      expect(await ctx.usdc.balanceOf(ctx.walletB.address)).to.equal(0n);
    });

    it("rejects a changed amount", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      await expectMismatch(ctx, [ctx.transfer(ctx.walletA.address, USDC(550_000))]);
    });

    it("rejects an extra privileged action (unapproved allowance)", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      const extra = {
        target: ctx.usdc.target,
        value: 0n,
        data: ctx.usdc.interface.encodeFunctionData("approve", [ctx.attacker.address, ethers.MaxUint256]),
        operation: 0,
      };
      await expectMismatch(ctx, [...ctx.approvedActions, extra]);
      expect(await ctx.usdc.allowance(ctx.guard.target, ctx.attacker.address)).to.equal(0n);
    });

    it("rejects a missing approved action", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      const twoActions = [ctx.transfer(ctx.walletA.address, USDC(250_000)), ctx.transfer(ctx.walletA.address, USDC(250_000))];
      await ctx.approve(twoActions);
      await expectMismatch(ctx, [twoActions[0]]);
    });

    it("rejects changed target and changed calldata", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      const otherToken = await ethers.deployContract("MockUSDC", [ctx.admin.address]);
      await expectMismatch(ctx, [{ ...ctx.approvedActions[0], target: otherToken.target }]);
      await expectMismatch(ctx, [{ ...ctx.approvedActions[0], data: ctx.approvedActions[0].data.slice(0, -2) + "01" }]);
    });

    it("rejects a manifest approved for a different guard / chain context", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      const otherGuard = await ethers.deployContract("ExecutionGuard", [
        ctx.governor.address,
        ctx.executor.address,
        ctx.guardian.address,
        REVIEW_WINDOW,
      ]);
      // Hash computed under the other guard's EIP-712 domain, then approved on this guard.
      const foreignHash = await otherGuard.hashManifest(KEY, 1, ctx.approvedActions);
      await ctx.guard.connect(ctx.governor).approveManifest(KEY, 1, foreignHash);
      await mine(Number(REVIEW_WINDOW));
      await expectMismatch(ctx, ctx.approvedActions);
    });

    it("rejects a stale manifest version", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve(ctx.approvedActions, 2);
      await expect(ctx.guard.connect(ctx.executor).execute(KEY, 1, ctx.approvedActions))
        .to.be.revertedWithCustomError(ctx.guard, "StaleVersion")
        .withArgs(2, 1);
    });

    it("rejects delegatecall operations", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      const delegate = [{ ...ctx.approvedActions[0], operation: 1 }];
      await ctx.approve(delegate);
      await expect(ctx.guard.connect(ctx.executor).execute(KEY, 1, delegate))
        .to.be.revertedWithCustomError(ctx.guard, "UnsupportedOperation")
        .withArgs(0, 1);
    });
  });

  describe("authorization and lifecycle", function () {
    it("rejects an unauthorized caller", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      await expect(ctx.guard.connect(ctx.outsider).execute(KEY, 1, ctx.approvedActions)).to.be.revertedWithCustomError(
        ctx.guard,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("only the governor can approve a manifest", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      const hash = await ctx.guard.hashManifest(KEY, 1, ctx.approvedActions);
      await expect(ctx.guard.connect(ctx.executor).approveManifest(KEY, 1, hash)).to.be.revertedWithCustomError(
        ctx.guard,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("rejects duplicate execution (replay)", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      await ctx.guard.connect(ctx.executor).execute(KEY, 1, ctx.approvedActions);
      await expect(ctx.guard.connect(ctx.executor).execute(KEY, 1, ctx.approvedActions))
        .to.be.revertedWithCustomError(ctx.guard, "AlreadyExecuted")
        .withArgs(KEY);
      expect(await ctx.usdc.balanceOf(ctx.walletA.address)).to.equal(USDC(500_000));
    });

    it("blocks execution during the review window", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      const hash = await ctx.guard.hashManifest(KEY, 1, ctx.approvedActions);
      await ctx.guard.connect(ctx.governor).approveManifest(KEY, 1, hash);
      await expect(ctx.guard.connect(ctx.executor).execute(KEY, 1, ctx.approvedActions)).to.be.revertedWithCustomError(
        ctx.guard,
        "ReviewWindowActive"
      );
    });

    it("guardian halt blocks execution and cannot be bypassed by re-approving the same version", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      const hash = await ctx.approve();
      const reason = ethers.id("simulation: undeclared fund movement");
      await expect(ctx.guard.connect(ctx.guardian).halt(KEY, reason))
        .to.emit(ctx.guard, "ProposalHalted")
        .withArgs(KEY, 1, hash, ctx.guardian.address, reason);
      await expect(ctx.guard.connect(ctx.executor).execute(KEY, 1, ctx.approvedActions))
        .to.be.revertedWithCustomError(ctx.guard, "ProposalIsHalted")
        .withArgs(KEY, reason);
      await expect(ctx.guard.connect(ctx.governor).approveManifest(KEY, 1, hash)).to.be.revertedWithCustomError(
        ctx.guard,
        "StaleVersion"
      );
      expect(await ctx.usdc.balanceOf(ctx.walletA.address)).to.equal(0n);
    });

    it("guardians cannot halt what is not approved, and non-guardians cannot halt", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await expect(ctx.guard.connect(ctx.guardian).halt(KEY, ethers.ZeroHash)).to.be.revertedWithCustomError(
        ctx.guard,
        "NotHaltable"
      );
      await ctx.approve();
      await expect(ctx.guard.connect(ctx.outsider).halt(KEY, ethers.ZeroHash)).to.be.revertedWithCustomError(
        ctx.guard,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("preflight reports the same custom error as execute without sending a transaction", async function () {
      const ctx = await loadFixture(deployGuardFixture);
      await ctx.approve();
      await expect(
        ctx.guard.preflight(KEY, 1, [ctx.transfer(ctx.walletB.address, USDC(500_000))])
      ).to.be.revertedWithCustomError(ctx.guard, "ManifestMismatch");
      expect(await ctx.guard.preflight(KEY, 1, ctx.approvedActions)).to.equal(
        await ctx.guard.hashManifest(KEY, 1, ctx.approvedActions)
      );
    });
  });
});

describe("AtlasGovernor -> ExecutionGuard end to end", function () {
  it("a successful token vote approves the manifest digest, which then executes", async function () {
    const [admin, executor, guardian, d1, d2, d3, walletA] = await ethers.getSigners();
    const token = await ethers.deployContract("AtlasToken", [admin.address]);
    const governor = await ethers.deployContract("AtlasGovernor", [token.target, 1, 10, 4]);
    const guard = await ethers.deployContract("ExecutionGuard", [governor.target, executor.address, guardian.address, 2]);
    const usdc = await ethers.deployContract("MockUSDC", [admin.address]);
    await usdc.mint(guard.target, USDC(1_000_000));
    for (const [signer, amount] of [[d1, 600], [d2, 300], [d3, 100]]) {
      await token.mint(signer.address, ethers.parseEther(String(amount)));
      await token.connect(signer).delegate(signer.address);
    }

    const actions = [{ target: usdc.target, value: 0n, data: usdc.interface.encodeFunctionData("transfer", [walletA.address, USDC(1000)]), operation: 0 }];
    const manifestHash = await guard.hashManifest(KEY, 1, actions);
    const calldata = guard.interface.encodeFunctionData("approveManifest", [KEY, 1, manifestHash]);
    const description = `GOV-042 v1\nmanifest:${manifestHash}`;
    await governor.propose([guard.target], [0], [calldata], description);
    const proposalId = await governor.hashProposal([guard.target], [0], [calldata], ethers.id(description));

    await mine(2);
    await governor.connect(d1).castVote(proposalId, 1);
    await governor.connect(d2).castVote(proposalId, 0);
    await governor.connect(d3).castVote(proposalId, 2);
    await mine(11);
    expect(await governor.state(proposalId)).to.equal(4n); // Succeeded
    await expect(governor.execute([guard.target], [0], [calldata], ethers.id(description))).to.emit(guard, "ManifestApproved");

    await mine(2);
    await guard.connect(executor).execute(KEY, 1, actions);
    expect(await usdc.balanceOf(walletA.address)).to.equal(USDC(1000));
  });
});

describe("ProposalRegistry", function () {
  async function registryFixture() {
    const [admin, committer, proposer, impostor] = await ethers.getSigners();
    const registry = await ethers.deployContract("ProposalRegistry", [admin.address, committer.address]);
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: "DAOGuard ProposalRegistry", version: "1", chainId, verifyingContract: registry.target };
    const types = {
      Disclosure: [
        { name: "proposalKey", type: "bytes32" },
        { name: "version", type: "uint64" },
        { name: "contentHash", type: "bytes32" },
        { name: "disclosureHash", type: "bytes32" },
      ],
    };
    const sign = (signer, version, contentHash, disclosureHash) =>
      signer.signTypedData(domain, types, { proposalKey: KEY, version, contentHash, disclosureHash });
    return { admin, committer, proposer, impostor, registry, sign };
  }

  it("commits sequential versions signed by the proposer", async function () {
    const { committer, proposer, registry, sign } = await loadFixture(registryFixture);
    const content = ethers.id("content v1");
    const disclosure = ethers.id("no affiliations");
    const sig = await sign(proposer, 1, content, disclosure);
    await expect(
      registry.connect(committer).commitVersion(KEY, 1, content, ethers.id("m"), ethers.id("e"), disclosure, proposer.address, sig)
    ).to.emit(registry, "VersionCommitted");
    const stored = await registry.getVersion(KEY, 1);
    expect(stored.contentHash).to.equal(content);
    expect(stored.proposer).to.equal(proposer.address);
  });

  it("rejects out-of-order versions and disclosures not signed by the proposer", async function () {
    const { committer, proposer, impostor, registry, sign } = await loadFixture(registryFixture);
    const content = ethers.id("content v1");
    const disclosure = ethers.id("no affiliations");
    const sig2 = await sign(proposer, 2, content, disclosure);
    await expect(
      registry.connect(committer).commitVersion(KEY, 2, content, ethers.ZeroHash, ethers.ZeroHash, disclosure, proposer.address, sig2)
    ).to.be.revertedWithCustomError(registry, "VersionOutOfOrder");
    const forged = await sign(impostor, 1, content, disclosure);
    await expect(
      registry.connect(committer).commitVersion(KEY, 1, content, ethers.ZeroHash, ethers.ZeroHash, disclosure, proposer.address, forged)
    ).to.be.revertedWithCustomError(registry, "InvalidDisclosureSignature");
  });

  it("anchors audit ledger heads and accepts disputes only for committed versions", async function () {
    const { committer, proposer, impostor, registry, sign } = await loadFixture(registryFixture);
    await expect(registry.connect(committer).anchorAudit(ethers.id("head"), 12)).to.emit(registry, "AuditAnchored");
    await expect(registry.connect(impostor).fileDispute(KEY, 1, ethers.id("d"))).to.be.revertedWithCustomError(
      registry,
      "UnknownVersion"
    );
    const content = ethers.id("c");
    const disclosure = ethers.id("d");
    await registry
      .connect(committer)
      .commitVersion(KEY, 1, content, ethers.ZeroHash, ethers.ZeroHash, disclosure, proposer.address, await sign(proposer, 1, content, disclosure));
    await expect(registry.connect(impostor).fileDispute(KEY, 1, ethers.id("d"))).to.emit(registry, "DisputeFiled");
  });
});

describe("FeeVault contested upgrade fixtures", function () {
  async function vaultFixture() {
    const [admin, governor, executor, guardian, payer, reconciler] = await ethers.getSigners();
    const usdc = await ethers.deployContract("MockUSDC", [admin.address]);
    const guard = await ethers.deployContract("ExecutionGuard", [governor.address, executor.address, guardian.address, 1]);
    const v1 = await ethers.deployContract("FeeVault");
    const init = v1.interface.encodeFunctionData("initialize", [usdc.target, guard.target, 30]);
    const proxy = await ethers.deployContract("TransparentUpgradeableProxy", [v1.target, guard.target, init]);
    const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    const proxyAdminAddr = ethers.getAddress("0x" + (await ethers.provider.getStorage(proxy.target, adminSlot)).slice(26));
    const proxyAdmin = await ethers.getContractAt("ProxyAdmin", proxyAdminAddr);
    const vault = await ethers.getContractAt("FeeVaultV2", proxy.target);
    await usdc.mint(payer.address, USDC(10_000_000));
    await usdc.connect(payer).approve(proxy.target, ethers.MaxUint256);
    await vault.connect(payer).recordFee(USDC(6_000_000)); // 18,000 mUSDC of fees
    const honest = await ethers.deployContract("FeeVaultV2");
    const backdoored = await ethers.deployContract("FeeVaultV2R", [reconciler.address]);

    const upgradeTo = (impl) => [{
      target: proxyAdmin.target,
      value: 0n,
      data: proxyAdmin.interface.encodeFunctionData("upgradeAndCall", [proxy.target, impl, "0x"]),
      operation: 0,
    }];
    async function approveAndExecute(actions) {
      const key = ethers.id("GOV-043");
      await guard.connect(governor).approveManifest(key, 1, await guard.hashManifest(key, 1, actions));
      await mine(1);
      await guard.connect(executor).execute(key, 1, actions);
    }
    return { usdc, guard, vault, proxyAdmin, honest, backdoored, upgradeTo, approveAndExecute, reconciler, guardian, governor, executor };
  }

  it("ProxyAdmin is owned by the guard", async function () {
    const { proxyAdmin, guard } = await loadFixture(vaultFixture);
    expect(await proxyAdmin.owner()).to.equal(guard.target);
  });

  it("the reviewed V2 keeps state and its sync hook moves no funds", async function () {
    const { usdc, vault, honest, upgradeTo, approveAndExecute, reconciler } = await loadFixture(vaultFixture);
    await approveAndExecute(upgradeTo(honest.target));
    expect(await vault.version()).to.equal("2.0.0");
    expect(await vault.feeBps()).to.equal(30n);
    await vault.connect(reconciler).syncAccounting();
    expect(await usdc.balanceOf(vault.target)).to.equal(USDC(18_000));
  });

  it("the obfuscated V2 lets the embedded reconciler drain the vault (what the simulator must catch)", async function () {
    const { usdc, vault, backdoored, upgradeTo, approveAndExecute, reconciler } = await loadFixture(vaultFixture);
    await approveAndExecute(upgradeTo(backdoored.target));
    await vault.connect(reconciler).syncAccounting();
    expect(await usdc.balanceOf(vault.target)).to.equal(0n);
    expect(await usdc.balanceOf(reconciler.address)).to.equal(USDC(18_000));
  });

  it("a guardian halt during the review window prevents the obfuscated upgrade", async function () {
    const { guard, vault, backdoored, upgradeTo, guardian, governor, executor } = await loadFixture(vaultFixture);
    const key = ethers.id("GOV-043");
    const actions = upgradeTo(backdoored.target);
    await guard.connect(governor).approveManifest(key, 1, await guard.hashManifest(key, 1, actions));
    await guard.connect(guardian).halt(key, ethers.id("simulation: fund movement by embedded address"));
    await mine(1);
    await expect(guard.connect(executor).execute(key, 1, actions)).to.be.revertedWithCustomError(guard, "ProposalIsHalted");
    expect(await vault.version()).to.equal("1.0.0");
  });
});
