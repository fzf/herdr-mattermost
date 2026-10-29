import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Herdr does not restart pane processes, so a crash or a bad token would leave
// the bridge dead. Restart main.js with backoff (5s → 5m); fixing .env self-heals.
const main = join(dirname(fileURLToPath(import.meta.url)), "main.js");
const MIN_UPTIME_MS = 30_000;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
let delay = BASE_DELAY_MS;

function start() {
  const child = spawn(process.execPath, [main], { stdio: "inherit" });
  const startedAt = Date.now();
  child.on("error", (err) => console.error(`herdr-mattermost: failed to spawn bot: ${err.message}`));
  child.on("exit", (code, signal) => {
    const upMs = Date.now() - startedAt;
    if (upMs >= MIN_UPTIME_MS) delay = BASE_DELAY_MS;
    console.error(`herdr-mattermost: bot exited (code=${code} signal=${signal}) after ${Math.round(upMs / 1000)}s; restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(start, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  });
}
start();
