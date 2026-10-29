import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTopicConfig } from "./topics.js";

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function readChannels(dirs) {
  for (const dir of dirs) {
    const path = join(dir, "channels.json");
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`herdr-mattermost: failed to parse ${path}: ${err.message}`);
      return {};
    }
  }
  return {};
}

export function loadConfig({
  env = process.env,
  root = env.HERDR_PLUGIN_ROOT ?? process.cwd(),
  configDir = env.HERDR_PLUGIN_CONFIG_DIR ?? root,
  stateDir = env.HERDR_PLUGIN_STATE_DIR ?? root,
} = {}) {
  // Config dir wins over the plugin root, so a local .env works for development.
  const fileEnv = { ...readEnvFile(join(root, ".env")), ...readEnvFile(join(configDir, ".env")) };
  const get = (key) => env[key] || fileEnv[key] || "";
  const channels = readChannels([configDir, root]);

  return {
    pluginId: env.HERDR_PLUGIN_ID ?? "herdr.mattermost",
    configDir,
    stateDir,
    url: get("MM_URL").replace(/\/+$/, ""),
    token: get("MM_TOKEN"),
    team: get("MM_TEAM"),
    allowedUsers: new Set(get("MM_ALLOWED_USERS").split(",").map((s) => s.trim()).filter(Boolean)),
    agentKind: get("HERDR_AGENT_KIND") || "claude",
    cwd: get("HERDR_WORKSPACE_CWD") || null,
    autostart: get("MM_AUTOSTART") === "1",
    statusPosts: get("MM_STATUS_POSTS") !== "0",
    outputLines: Math.min(Math.max(parseInt(get("MM_OUTPUT_LINES") || "30", 10) || 30, 1), 80),
    pollMs: Math.max(parseInt(get("MM_POLL_MS") || "3000", 10) || 3000, 1000),
    channels,
    // A channel is watched when channels.json has it (by id or "team/name") or
    // its header/purpose carries a `herdr:` marker. Null = not watched.
    channelConfig(channelId, header, channelKey) {
      if (channels[channelId]) return channels[channelId];
      if (channelKey && channels[channelKey]) return channels[channelKey];
      return parseTopicConfig(header);
    },
  };
}

export const config = loadConfig();

export function requireConfig(c = config) {
  const missing = ["url", "token", "team"].filter((k) => !c[k]);
  if (missing.length) {
    const keys = { url: "MM_URL", token: "MM_TOKEN", team: "MM_TEAM" };
    console.error(
      `herdr-mattermost: ${missing.map((k) => keys[k]).join(", ")} not set. Copy .env.example to ${join(c.configDir, ".env")} and fill it in.`,
    );
    process.exit(1);
  }
  return c;
}
