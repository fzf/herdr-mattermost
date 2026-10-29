import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../src/bot.js";
import { OutputWriter } from "../src/output.js";
import { Relay } from "../src/relay.js";
import { loadConfig } from "../src/config.js";
import { NUMBER_EMOJI } from "../src/reactions.js";

function fakeMM({ headers = {} } = {}) {
  const posts = [];
  const reactions = [];
  const removed = [];
  let n = 0;
  return {
    userId: "bot", posts, reactions, removed,
    async channel(id) { return { id, name: `chan-${id}`, display_name: `Chan ${id}`, header: headers[id] ?? "", purpose: "" }; },
    async user(id) { return { id, username: `user-${id}` }; },
    async createPost({ channelId, rootId, message }) { const p = { id: `b${++n}`, channel_id: channelId, root_id: rootId, message }; posts.push(p); return p; },
    async editPost(id, message) { const p = posts.find((x) => x.id === id); if (p) p.message = message; return p; },
    async addReaction(postId, emoji) { reactions.push([postId, emoji]); },
    async removeReaction(postId, emoji) { removed.push([postId, emoji]); },
    async fileInfo(id) { return { name: `${id}.txt` }; },
    async downloadFile(id, dest) { return dest; },
    async threadPosts() { return { order: [], posts: {} }; },
    connect() { return { close() {} }; },
  };
}

function fakeHerdr() {
  const calls = { prompt: [], sendKeys: [], closeTab: [], startAgent: [] };
  let agents = [];
  let reads = "";
  return {
    calls,
    setAgents(a) { agents = a; },
    setRead(t) { reads = t; },
    async listWorkspaces() { return [{ workspace_id: "ws1", label: "api", cwd: "/x" }]; },
    async ensureWorkspace({ workspaceId }) { return { workspace_id: workspaceId ?? "ws-new" }; },
    async createTab({ label }) { return { tab: { tab_id: "tab1" }, root_pane: { pane_id: "pane1" }, label }; },
    async listAgents() { return agents; },
    async startAgent(a) { calls.startAgent.push(a); },
    async promptAgent(...a) { calls.prompt.push(a); },
    async getAgent(name) { const a = agents.find((x) => x.name === name); return a ?? {}; },
    async readAgent() { return reads; },
    async sendKeys(...a) { calls.sendKeys.push(a); },
    async sendText() {},
    async closeTab(...a) { calls.closeTab.push(a); },
  };
}

function setup({ headers = {}, allowed = new Set(["u1"]), channels = {} } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "hm-state-"));
  const configDir = mkdtempSync(join(tmpdir(), "hm-conf-"));
  const config = loadConfig({ env: { MM_URL: "https://x", MM_TOKEN: "t", MM_TEAM: "home", MM_STATUS_POSTS: "1" }, root: configDir, configDir, stateDir });
  const mm = fakeMM({ headers });
  const herdr = fakeHerdr();
  const state = { channels, threads: {} };
  const output = new OutputWriter({ mm });
  const bot = createBot({ config, mm, herdr, state, saveState() {}, output, relay: new Relay(), team: { id: "team", name: "home" }, allowed, log: { error() {}, log() {} }, sleep: async () => {} });
  return { bot, mm, herdr, state };
}

const rootPost = (over = {}) => ({ id: "r1", channel_id: "c1", root_id: "", user_id: "u1", type: "", message: "fix the login bug", create_at: 100, ...over });

test("root post in a watched channel starts an agent and sends the text as the first prompt", async () => {
  const { bot, herdr, state, mm } = setup({ headers: { c1: "herdr: kind=codex" } });
  await bot.handlePosted(rootPost(), { sender_name: "@fzf" });
  assert.equal(herdr.calls.startAgent.length, 1);
  assert.equal(herdr.calls.startAgent[0].kind, "codex");
  assert.equal(state.threads.r1.agent_name, "mm-fix-the-login-bug");
  assert.deepEqual(herdr.calls.prompt, [["mm-fix-the-login-bug", "fix the login bug", null]]);
  assert.ok(mm.posts.some((p) => p.root_id === "r1" && /is up/.test(p.message)));
});

test("root post in an unwatched channel is ignored; mapped threads keep working after the header loses the marker", async () => {
  const { bot, herdr, state, mm } = setup({ headers: { c1: "nothing here" } });
  await bot.handlePosted(rootPost(), null);
  assert.equal(herdr.calls.startAgent.length, 0);
  state.threads.r1 = { root_id: "r1", channel_id: "c1", agent_name: "a", pane_id: "p", kind: "claude", machine: null, last_status: "idle", last_seen_at: 0 };
  await bot.handlePosted({ id: "m2", channel_id: "c1", root_id: "r1", user_id: "u1", type: "", message: "continue", create_at: 200 }, { sender_name: "@fzf" });
  assert.deepEqual(herdr.calls.prompt, [["a", "fzf: continue", null]]);
  assert.equal(state.threads.r1.last_seen_at, 200);
  assert.deepEqual(mm.reactions.at(-1), ["m2", "white_check_mark"]);
});

test("root post with only attachments still starts an agent with the file paths as the prompt", async () => {
  const { bot, herdr } = setup({ headers: { c1: "herdr:" } });
  await bot.handlePosted(rootPost({ message: "", file_ids: ["f1"] }), null);
  assert.equal(herdr.calls.startAgent.length, 1);
  assert.match(herdr.calls.prompt[0][1], /r1-f1\.txt$/);
});

test("bot's own posts, system posts and unauthorized users are ignored", async () => {
  const { bot, herdr } = setup({ headers: { c1: "herdr:" } });
  await bot.handlePosted(rootPost({ user_id: "bot" }), null);
  await bot.handlePosted(rootPost({ type: "system_join_channel" }), null);
  await bot.handlePosted(rootPost({ user_id: "stranger" }), null);
  assert.equal(herdr.calls.startAgent.length, 0);
});

test("blocked agent → prompt post with number reactions; a user reaction sends keys, a bot reaction is ignored", async () => {
  const { bot, herdr, state, mm } = setup({ headers: { c1: "herdr:" } });
  await bot.handlePosted(rootPost(), null);
  const m = state.threads.r1;
  herdr.setAgents([{ name: m.agent_name, status: "working" }]);
  herdr.setRead("");
  await bot.poll();
  herdr.setRead("Allow edit?\n❯ 1. Yes\n  2. No");
  herdr.setAgents([{ name: m.agent_name, status: "blocked" }]);
  await bot.poll();
  assert.ok(m.prompt_post_id, "prompt post recorded");
  assert.deepEqual(mm.reactions.filter(([id]) => id === m.prompt_post_id).map(([, e]) => e), NUMBER_EMOJI.slice(0, 2));
  await bot.handleReaction({ user_id: "bot", post_id: m.prompt_post_id, emoji_name: "two" });
  assert.equal(herdr.calls.sendKeys.length, 0);
  const promptId = m.prompt_post_id;
  await bot.handleReaction({ user_id: "u1", post_id: promptId, emoji_name: "two" });
  assert.deepEqual(herdr.calls.sendKeys, [[m.agent_name, ["down", "enter"], null]]);
  assert.equal(m.prompt_post_id, undefined);
  assert.match(mm.posts.find((p) => p.id === promptId).message, /chose `2\. No`/);
  assert.ok(mm.removed.some(([id, e]) => id === promptId && e === "one"));
});

test("!setup lists workspaces with number reactions and a reaction binds the channel", async () => {
  const { bot, state, mm } = setup({ headers: {} });
  await bot.handlePosted(rootPost({ message: "!setup" }), null);
  const list = mm.posts.find((p) => /Bind this channel/.test(p.message));
  assert.ok(list);
  assert.deepEqual(mm.reactions.filter(([id]) => id === list.id).map(([, e]) => e), ["one", "two"]);
  await bot.handleReaction({ user_id: "u1", post_id: list.id, emoji_name: "one" });
  assert.deepEqual(state.channels.c1, { bound: true, machine: null, workspace_id: "ws1" });
  assert.match(mm.posts.find((p) => p.id === list.id).message, /bound to workspace `ws1`/);
});

test("!close closes the tab and unmaps the thread", async () => {
  const { bot, herdr, state } = setup({ headers: { c1: "herdr:" } });
  await bot.handlePosted(rootPost(), null);
  await bot.handlePosted({ id: "m9", channel_id: "c1", root_id: "r1", user_id: "u1", type: "", message: "!close", create_at: 300 }, null);
  assert.deepEqual(herdr.calls.closeTab, [["tab1", null]]);
  assert.equal(state.threads.r1, undefined);
});

test("relayed output is appended in place and the done transition announces", async () => {
  const { bot, herdr, state, mm } = setup({ headers: { c1: "herdr:" } });
  await bot.handlePosted(rootPost(), null);
  const m = state.threads.r1;
  const stable = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  herdr.setAgents([{ name: m.agent_name, status: "working" }]);
  herdr.setRead(stable.join("\n"));
  await bot.poll(); // seeds baseline
  herdr.setRead([...stable, "hello world", "⠋ spinner"].join("\n"));
  await bot.poll();
  herdr.setRead([...stable, "hello world", "⠙ spinner"].join("\n"));
  await bot.poll();
  const out = mm.posts.filter((p) => p.message.startsWith("```text"));
  assert.equal(out.length, 1);
  assert.match(out[0].message, /hello world/);
  herdr.setAgents([{ name: m.agent_name, status: "done" }]);
  await bot.poll();
  assert.ok(mm.posts.some((p) => /finished/.test(p.message)));
});

test("agent start is retried while the new pane's shell is still starting (agent_pane_busy)", async () => {
  const { bot, herdr, state } = setup({ headers: { c1: "herdr:" } });
  let attempts = 0;
  herdr.startAgent = async (a) => {
    attempts++;
    if (attempts < 3) { const e = new Error("agent target pane is not an available shell"); e.code = "agent_pane_busy"; throw e; }
    herdr.calls.startAgent.push(a);
  };
  await bot.handlePosted(rootPost(), null);
  assert.equal(attempts, 3);
  assert.equal(herdr.calls.startAgent.length, 1);
  assert.ok(state.threads.r1, "mapping created after retry");
});

test("a cwd starting with ~ is expanded before it reaches herdr", async () => {
  const { bot, herdr } = setup({ headers: { c1: "herdr: cwd=~/code/x" } });
  const seen = {};
  const origWs = herdr.ensureWorkspace, origTab = herdr.createTab;
  herdr.ensureWorkspace = async (a) => { seen.ws = a.cwd; return origWs(a); };
  herdr.createTab = async (a) => { seen.tab = a.cwd; return origTab(a); };
  await bot.handlePosted(rootPost(), null);
  assert.ok(seen.ws && !seen.ws.startsWith("~"), `workspace cwd not expanded: ${seen.ws}`);
  assert.ok(seen.tab && !seen.tab.startsWith("~"), `tab cwd not expanded: ${seen.tab}`);
  assert.ok(seen.tab.endsWith("/code/x"));
});
