// One-time setup: installs contracts/frontend packages, creates the Python venv, compiles the
// contracts and exports their ABIs to the backend. Safe to re-run.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const win = process.platform === "win32";
const run = (cmd, cwd = root) => {
  console.log(`\n> ${cmd}  (${cwd.replace(root, ".") || "."})`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
};

const python = (() => {
  for (const candidate of win ? ["py -3", "python"] : ["python3", "python"]) {
    try {
      const v = execSync(`${candidate} -c "import sys; print(sys.version_info[:2] >= (3, 11))"`, { encoding: "utf8" }).trim();
      if (v === "True") return candidate;
    } catch {
      /* try the next interpreter */
    }
  }
  console.error("Python 3.11+ is required.");
  process.exit(1);
})();

run("npm install --no-audit --no-fund", join(root, "contracts"));
run("npm install --no-audit --no-fund", join(root, "frontend"));
const venv = join(root, "backend", ".venv");
if (!existsSync(venv)) run(`${python} -m venv .venv`, join(root, "backend"));
const venvPython = win ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
run(`"${venvPython}" -m pip install --upgrade pip -q`, join(root, "backend"));
run(`"${venvPython}" -m pip install -r requirements.txt`, join(root, "backend"));
run("npx hardhat compile", join(root, "contracts"));
run("node scripts/export-artifacts.js", join(root, "contracts"));
console.log("\nSetup complete. Start everything with:  npm run dev");
