// Optional: sets up the assistant's local, open-source AI. Pulls the embedding and chat models
// into Ollama (https://ollama.com, install it first) and trains the intent model, printing its
// evaluation. Without Ollama the assistant still works on the trained model alone. Safe to re-run.
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const win = process.platform === "win32";
const run = (cmd, cwd = root) => {
  console.log(`\n> ${cmd}  (${cwd.replace(root, ".") || "."})`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
};

let ollama = true;
try {
  execSync("ollama --version", { stdio: "ignore", shell: true });
} catch {
  ollama = false;
  console.log("Ollama is not installed, so only the intent model is trained. Install it from https://ollama.com and re-run for open-ended answers.");
}
if (ollama) {
  run("ollama pull nomic-embed-text");
  run("ollama pull qwen2.5:3b");
}
const venvPython = win ? join(root, "backend", ".venv", "Scripts", "python.exe") : join(root, "backend", ".venv", "bin", "python");
run(`"${venvPython}" -m app.assistant.train`, join(root, "backend"));
console.log("\nLocal AI ready. Start everything with:  npm run dev");
