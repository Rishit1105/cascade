// Starts the local Hardhat node, the FastAPI backend and the Vite frontend with prefixed logs.
// Services already listening on their port are reused. Ctrl+C stops everything this script started.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const win = process.platform === "win32";
const venvPython = win ? join(root, "backend", ".venv", "Scripts", "python.exe") : join(root, "backend", ".venv", "bin", "python");
const children = [];
const colors = { chain: "\x1b[35m", api: "\x1b[36m", web: "\x1b[32m", dev: "\x1b[33m" };
const log = (tag, line) => console.log(`${colors[tag] ?? ""}[${tag}]\x1b[0m ${line}`);

if (!existsSync(venvPython) || !existsSync(join(root, "frontend", "node_modules")) || !existsSync(join(root, "contracts", "node_modules"))) {
  log("dev", "Dependencies are missing. Run `npm run setup` first.");
  process.exit(1);
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.end();
      res(true);
    });
    s.on("error", () => res(false));
  });

async function waitFor(port, label, timeoutMs = 120_000) {
  const start = Date.now();
  while (!(await portOpen(port))) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} did not open port ${port}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

function start(tag, cmd, args, cwd, env = {}, quiet = false) {
  // With shell: true on Windows, a path containing spaces (e.g. C:\Users\First Last) must be quoted.
  const command = win && cmd.includes(" ") ? `"${cmd}"` : cmd;
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: win, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream) =>
    stream.on("data", (buf) =>
      buf
        .toString()
        .split(/\r?\n/)
        .filter((l) => l.trim() && !(quiet && /eth_|net_|web3_|hardhat_|evm_|debug_|Contract call|Transaction:|From:|To:|Value:|Gas used|Block #|Contract deployment|Contract address/.test(l)))
        .forEach((l) => log(tag, l)),
    );
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => log(tag, `exited with code ${code}`));
  children.push(child);
  return child;
}

function stopAll() {
  for (const c of children) {
    try {
      if (win) execSync(`taskkill /T /F /PID ${c.pid}`, { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

if (await portOpen(8545)) log("dev", "Reusing the Hardhat node already running on :8545");
else {
  start("chain", "npx", ["hardhat", "node", "--hostname", "127.0.0.1", "--port", "8545"], join(root, "contracts"), { DAOGUARD_NODE: "1" }, true);
  await waitFor(8545, "Hardhat node");
  log("dev", "Local chain ready on http://127.0.0.1:8545 (chain id 31337)");
}

if (await portOpen(8000)) log("dev", "Reusing the API already running on :8000");
else {
  start("api", venvPython, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], join(root, "backend"));
  await waitFor(8000, "API");
}

if (await portOpen(5173)) log("dev", "Reusing the web app already running on :5173");
else {
  start("web", "npm", ["run", "dev"], join(root, "frontend"));
  await waitFor(5173, "web app");
}
log("dev", "DAOGuard is starting: open http://127.0.0.1:5173  (the first start deploys and seeds the demo chain, ~10 s)");
log("dev", "Press Ctrl+C to stop.");
