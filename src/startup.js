import { spawnSync } from "node:child_process";
import { config } from "./config.js";

// Reopen the bot tab after the Herdr server (re)starts. Set MM_AUTOSTART=1.
if (!config.autostart) process.exit(0);

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
function run(args) {
  const res = spawnSync(herdr, args, { encoding: "utf8" });
  if (res.status !== 0) return null;
  try { return JSON.parse(res.stdout).result ?? null; } catch { return null; }
}

function ensureWorkspace() {
  const list = run(["workspace", "list"]);
  const workspaces = list?.workspaces ?? (Array.isArray(list) ? list : []);
  const existing = workspaces.find((w) => w.label === "mattermost") ?? workspaces[0];
  if (existing) return existing.workspace_id;
  const created = run(["workspace", "create", "--label", "mattermost", "--no-focus"]);
  return created?.workspace?.workspace_id ?? null;
}

const workspaceId = ensureWorkspace();
if (!workspaceId) { console.error("herdr-mattermost: autostart failed: could not find or create a workspace"); process.exit(1); }
run(["workspace", "focus", workspaceId]);
const opened = run(["plugin", "pane", "open", "--plugin", config.pluginId, "--entrypoint", "bot", "--placement", "tab"]);
if (!opened) { console.error("herdr-mattermost: autostart failed: plugin pane open returned an error"); process.exit(1); }
console.log(`herdr-mattermost: bot tab opened in workspace ${workspaceId}`);
