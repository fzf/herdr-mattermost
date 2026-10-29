import { config, requireConfig } from "./config.js";
import * as herdr from "./herdr.js";
import { MattermostClient } from "./mattermost.js";
import { createBot } from "./bot.js";
import { OutputWriter } from "./output.js";
import { Relay } from "./relay.js";
import { loadState, saveState } from "./state.js";

requireConfig();
const mm = new MattermostClient({ url: config.url, token: config.token });

const me = await mm.me();
const team = await mm.teamByName(config.team);

// MM_ALLOWED_USERS may hold usernames or ids; resolve to ids once.
const allowed = new Set();
for (const entry of config.allowedUsers) {
  const u = await mm.userByUsername(entry).catch(() => null);
  allowed.add(u?.id ?? entry);
}

// channels.json keys may be "team/channel-name"; resolve those to ids.
for (const key of Object.keys(config.channels)) {
  const m = key.match(/^([^/]+)\/(.+)$/);
  if (!m) continue;
  const ch = await mm.channelByName(team.id, m[2]).catch(() => null);
  if (ch) config.channels[ch.id] = config.channels[key];
  else console.error(`herdr-mattermost: channels.json entry "${key}" not found in team ${config.team}`);
}

const bot = createBot({
  config, mm, herdr,
  state: loadState(), saveState,
  output: new OutputWriter({ mm }),
  relay: new Relay(),
  team: { id: team.id, name: team.name },
  allowed,
});

console.log(`herdr-mattermost: logged in as @${me.username} on ${config.url} (team ${team.name}); allowed users: ${allowed.size || "anyone"}`);
bot.start();
process.on("SIGTERM", () => { bot.stop(); process.exit(0); });
process.on("SIGINT", () => { bot.stop(); process.exit(0); });
