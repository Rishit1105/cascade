require("@nomicfoundation/hardhat-toolbox");

// The local node starts 30 days in the past so the backend's seed can lay down a realistic,
// timestamped history (funding transfers, past votes) and then fast-forward to real time.
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// When running as the DAOGuard demo node, reverted transactions are mined (status 0) instead of
// being thrown back to the caller, so a contract-enforced rejection has a real tx hash and block.
const RUNNING_AS_DEMO_NODE = process.env.DAOGUARD_NODE === "1";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
      initialDate: new Date(Date.now() - THIRTY_DAYS_MS).toISOString(),
      accounts: { count: 26 },
      mining: { auto: true, interval: 0 },
      throwOnTransactionFailures: !RUNNING_AS_DEMO_NODE,
    },
  },
  mocha: { timeout: 120000 },
};
