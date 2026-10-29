import { config } from "../config.js";
import { loadState } from "../state.js";
import { listAgents } from "../herdr.js";

const state = loadState();
const agents = await listAgents().catch(() => []);
const byName = new Map(agents.map((a) => [a.name ?? a.agent, a.status ?? a.agent_status]));

console.log(`herdr-mattermost bridge (${config.configDir})`);
console.log(`server: ${config.url || "MISSING — set MM_URL"} · team: ${config.team || "MISSING — set MM_TEAM"}`);
console.log(`token: ${config.token ? "configured" : "MISSING — set MM_TOKEN"}`);
console.log(`channels.json entries: ${Object.keys(config.channels).length}`);
console.log(`default kind: ${config.agentKind}`);
console.log("");
const threads = Object.entries(state.threads);
if (!threads.length) console.log("no mapped threads");
for (const [rootId, t] of threads) {
  const live = byName.get(t.agent_name) ?? t.last_status;
  console.log(`post ${rootId} -> ${t.agent_name} (${t.kind}) [${live}] ws:${t.workspace_id} tab:${t.tab_id}`);
}
