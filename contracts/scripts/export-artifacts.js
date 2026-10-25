// Copies ABI + bytecode for the contracts the backend deploys into backend/app/chain/artifacts.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(ROOT, "..", "backend", "app", "chain", "artifacts");

const CONTRACTS = {
  ExecutionGuard: "contracts/ExecutionGuard.sol",
  ProposalRegistry: "contracts/ProposalRegistry.sol",
  MockUSDC: "contracts/Tokens.sol",
  AtlasToken: "contracts/Tokens.sol",
  AtlasGovernor: "contracts/AtlasGovernor.sol",
  FeeVault: "contracts/FeeVault.sol",
  FeeVaultV2: "contracts/FeeVault.sol",
  FeeVaultV2R: "contracts/FeeVault.sol",
  TransparentUpgradeableProxy:
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
  ProxyAdmin: "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, source] of Object.entries(CONTRACTS)) {
  const file = path.join(ROOT, "artifacts", source, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Missing artifact for ${name} at ${file}. Run "npx hardhat compile" first.`);
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const exported = {
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
  };
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(exported, null, 2));
  console.log(`exported ${name}`);
}
