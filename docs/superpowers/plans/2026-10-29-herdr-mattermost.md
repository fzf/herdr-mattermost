# herdr-mattermost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A herdr plugin that uses Mattermost as the chat UI for herdr coding agents: channels are workspaces, root posts spawn agents, threads carry prompts in and output out.

**Architecture:** A single long-running Node process (the bot) runs as a herdr plugin pane. It listens to Mattermost over the websocket (no inbound HTTP), drives herdr through the `herdr` CLI (JSON in/out), and polls `herdr agent list` / `agent read` to relay output and status into threads. Pure logic (relay diffing, prompt parsing, chunking, reaction mapping, catch-up) lives in small modules with node:test coverage; `bot.js` is orchestration built from injected dependencies so it is testable with fakes; `main.js` wires the real ones.

**Tech Stack:** Node ≥ 22 (global `fetch` and `WebSocket`), ESM, zero runtime dependencies, `node --test`. herdr CLI as the plugin API.

**Spec:** `docs/superpowers/specs/2026-10-29-herdr-mattermost-design.md`

## Global Constraints

- Node `>= 22`; ESM (`"type": "module"`); no build step; no runtime dependencies.
- All herdr calls go through `src/herdr.js` using `HERDR_BIN_PATH` (fallback `herdr`); `--machine` is added only by `withMachine`.
- Plugin id `herdr.mattermost`; config in `HERDR_PLUGIN_CONFIG_DIR/.env`; state in `HERDR_PLUGIN_STATE_DIR/state.json` (`state.local.json` when `HERDR_ENV` is unset).
- `.env` keys exactly: `MM_URL`, `MM_TOKEN`, `MM_TEAM`, `MM_ALLOWED_USERS`, `HERDR_AGENT_KIND`, `HERDR_WORKSPACE_CWD`, `MM_AUTOSTART`, `MM_STATUS_POSTS`, `MM_OUTPUT_LINES`, `MM_POLL_MS`.
- `POST_LIMIT = 16000` characters per Mattermost post including the code fence.
- Emoji names: `one`…`nine`, `keycap_ten`, `white_check_mark`, `x`, `hourglass_flowing_sand`, `inbox_tray`, `zap`, `keyboard`, `+1`.
- Commits: imperative subject, one logical change each; never commit `.env` or state files.
- Never post from inside tests; every test runs offline with fakes.

## Review Focus

1. A root post with attachments and no text must still start an agent, with the downloaded file paths as the prompt (Task 12 test "root post with only attachments").
2. The bot's own reactions on a prompt post must never be treated as answers (Task 7 test "ignores the bot's own user id", Task 12 test "bot reaction is ignored").
3. After a websocket reconnect, catch-up must process posts strictly newer than `last_seen_at` and nothing already handled (Task 8 test "excludes posts at or before since").
4. A single output line longer than `POST_LIMIT` must be hard-split, never dropped and never posted over the limit (Task 5 test "hard-splits a single overlong line").
5. Removing `herdr:` from a channel header must stop new agents but keep existing threads working (Task 12 test "unwatched channel keeps mapped threads").

---

## File structure

```
herdr-plugin.toml          manifest: pane bot, startup hook, actions open-bot/status
package.json               name, version, scripts (test, version)
.env.example               documented config keys
channels.example.json      per-channel override example
.gitignore                 .env, state*.json, node_modules
LICENSE                    MIT (new code); README credits upstream
scripts/sync-version.js    copies package.json version into herdr-plugin.toml
scripts/setup-bot.sh       one-time server setup via mmctl --local
src/herdr.js               CLI wrapper (carried over)
src/relay.js               scrollback diffing (carried over)
src/prompts.js             blocked-prompt parsing (carried over)
src/topics.js              `herdr:` marker parsing (carried over)
src/capabilities.js        per-kind mid-turn strategy (carried over)
src/state.js               state.json load/save (carried over)
src/config.js              .env + channels.json → config object (MM_* keys)
src/chunk.js               fence-safe chunking, POST_LIMIT, canAppend
src/starter.js             directives, tab label, agent slug
src/reactions.js           prompt post text + emoji→keys plan
src/catchup.js             filter thread posts after reconnect
src/mattermost.js          MattermostClient: REST + websocket with reconnect
src/output.js              OutputWriter: append-in-place relay posts
src/thread-input.js        prompt routing for a mapped thread (adapted)
src/bot.js                 createBot({deps}): orchestration, event handlers, poller
src/main.js                wires real deps, starts the bot
src/run.js                 supervisor with backoff (pane entrypoint)
src/startup.js             autostart hook
src/actions/open-bot.js    action: open the bot pane
src/actions/status.js      action: print bridge state
test/*.test.js             one per module
```

---

### Task 1: Scaffold the repo

**Files:**
- Create: `package.json`, `herdr-plugin.toml`, `.gitignore`, `LICENSE`, `.env.example`, `channels.example.json`, `scripts/sync-version.js`, `test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` runs `node --test test/`; `npm version` syncs the manifest.

- [ ] **Step 1: Write the failing smoke test**

`test/smoke.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("manifest and package versions match", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const toml = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  assert.match(toml, new RegExp(`^version = "${pkg.version.replace(/\./g, "\\.")}"$`, "m"));
  assert.match(toml, /^id = "herdr\.mattermost"$/m);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/`
Expected: FAIL (package.json missing).

- [ ] **Step 3: Create the scaffold files**

`package.json`:
```json
{
  "name": "herdr-mattermost",
  "version": "0.1.0",
  "private": true,
  "description": "Herdr plugin: Mattermost as a UI layer. Channels are workspaces, root posts are agents.",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/main.js",
    "test": "node --test test/",
    "version": "node scripts/sync-version.js && git add herdr-plugin.toml"
  }
}
```

`herdr-plugin.toml`:
```toml
id = "herdr.mattermost"
name = "Mattermost"
version = "0.1.0"
min_herdr_version = "0.9.0"
description = "Use Mattermost as a UI layer for Herdr: channels map to workspaces, root posts spawn agents in tabs."
platforms = ["linux", "macos"]

[[startup]]
command = ["node", "src/startup.js"]

[[panes]]
id = "bot"
title = "Mattermost bot"
placement = "tab"
command = ["node", "src/run.js"]

[[actions]]
id = "open-bot"
title = "Open Mattermost bot"
contexts = ["workspace"]
command = ["node", "src/actions/open-bot.js"]

[[actions]]
id = "status"
title = "Mattermost bridge status"
command = ["node", "src/actions/status.js"]
```

`scripts/sync-version.js`:
```js
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const path = "herdr-plugin.toml";
const toml = readFileSync(path, "utf8").replace(/^version = ".*"$/m, `version = "${pkg.version}"`);
writeFileSync(path, toml);
console.log(`herdr-plugin.toml version -> ${pkg.version}`);
```

`.gitignore`:
```
node_modules/
.env
state.json
state.local.json
files/
```

`.env.example`:
```
# Required: Mattermost base URL (no trailing slash) and a bot account token.
# Create the bot with scripts/setup-bot.sh on the Mattermost host.
MM_URL=https://chat.example.org
MM_TOKEN=

# Required: team name (the URL slug, e.g. "home").
MM_TEAM=home

# Optional: comma-separated usernames or user ids allowed to spawn/prompt agents.
# Empty = anyone who can post in a watched channel.
MM_ALLOWED_USERS=

# Default agent kind for new root posts. Any kind `herdr agent start` accepts.
HERDR_AGENT_KIND=claude

# Default working directory for workspaces/tabs created by the bridge.
HERDR_WORKSPACE_CWD=

# Open the bot tab automatically when the Herdr server starts (startup hook).
MM_AUTOSTART=0

# Post agent status transitions (blocked/done) into the thread.
MM_STATUS_POSTS=1

# Lines of agent output for `!read` when no count is given.
MM_OUTPUT_LINES=30

# How often to poll `herdr agent list` for status changes (ms).
MM_POLL_MS=3000
```

`channels.example.json`:
```json
{
  "juxd1x6rbjbppju6jddk6exxgw": { "label": "my-api", "cwd": "~/code/my-api", "kind": "claude" },
  "home/infra": { "cwd": "/srv/infra", "kind": "codex", "machine": "gpu-box" }
}
```

`LICENSE`: the MIT license text with `Copyright (c) 2026 fzf`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Scaffold herdr-mattermost plugin"
```

---

### Task 2: Carry over the pure modules and their tests

**Files:**
- Create: `src/herdr.js`, `src/relay.js`, `src/prompts.js`, `src/topics.js`, `src/capabilities.js`, `src/state.js`, `test/relay.test.js`, `test/capabilities.test.js`

**Interfaces:**
- Produces (used by later tasks, signatures unchanged from upstream):
  - `herdr(args, {timeout, machine})`, `herdrText(args, opts)`, `listAgents(machine)`, `listWorkspaces(machine)`, `ensureWorkspace({workspaceId, cwd, label, machine})`, `createTab({workspaceId, cwd, label, machine})`, `startAgent({name, kind, paneId, machine})`, `promptAgent(target, text, machine)`, `getAgent(target, machine)`, `readAgent(target, {source, lines, machine})`, `sendKeys(target, keys, machine)`, `sendText(paneId, text, machine)`, `closeTab(tabId, machine)`, `HerdrError`
  - `class Relay { update(threadId, text) -> string[]; flush(threadId) -> string[]; has(id); drop(id) }`, `collapse(lines)`
  - `parsePrompt(snapshot) -> {type:"options"|"yesno"|"unknown", options?, cursor?}`, `keysForOption(parsed, i) -> string[]`
  - `parseTopicConfig(topic) -> object|null`
  - `midTurnStrategy(kind) -> "queue"|"hold"`, `midTurnDescription(kind)`
  - `loadState() -> {channels:{}, threads:{}}`, `saveState(state)`

- [ ] **Step 1: Copy the files from the installed Discord plugin**

```bash
SRC=~/.config/herdr/plugins/github-installations/herdr.discord-8c05a78364bf/4344-0/checkout
mkdir -p src test
cp $SRC/src/herdr.js $SRC/src/relay.js $SRC/src/prompts.js $SRC/src/topics.js $SRC/src/capabilities.js $SRC/src/state.js src/
cp $SRC/test/relay.test.js $SRC/test/capabilities.test.js test/
```

- [ ] **Step 2: Fix the two references that name the old plugin**

In `src/topics.js` the header comment says "Discord channel topic" — change the comment to "Mattermost channel header (or purpose)" and the "Forum channels work too" line to nothing. In `src/state.js` nothing references Discord; leave it. `src/state.js` imports `./config.js`, which Task 3 creates; until then the relay/capabilities tests still pass because they do not import state.

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: all relay and capabilities tests pass (the smoke test too).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Carry over relay, prompt, topic, capability, herdr and state modules"
```

---

### Task 3: config.js with MM_* keys

**Files:**
- Create: `src/config.js`, `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig({ env = process.env, root, configDir, stateDir }) -> config` where config has `pluginId, configDir, stateDir, url, token, team, allowedUsers: Set<string>, agentKind, cwd, autostart, statusPosts, outputLines, pollMs, channels, channelConfig(channelId, header, channelKey)`; and a default `config` export built from the process environment. `requireConfig()` exits with a message when `url`/`token`/`team` are missing.

- [ ] **Step 1: Write the failing test**

`test/config.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function dir(files = {}) {
  const d = mkdtempSync(join(tmpdir(), "hm-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

test("reads MM_* keys from the config dir .env and applies defaults", () => {
  const configDir = dir({ ".env": "MM_URL=https://mm.example/\nMM_TOKEN=abc\nMM_TEAM=home\nMM_ALLOWED_USERS=fzf, u2\n" });
  const c = loadConfig({ env: {}, root: dir(), configDir, stateDir: dir() });
  assert.equal(c.url, "https://mm.example"); // trailing slash stripped
  assert.equal(c.token, "abc");
  assert.equal(c.team, "home");
  assert.deepEqual([...c.allowedUsers], ["fzf", "u2"]);
  assert.equal(c.agentKind, "claude");
  assert.equal(c.pollMs, 3000);
  assert.equal(c.outputLines, 30);
  assert.equal(c.statusPosts, true);
  assert.equal(c.autostart, false);
});

test("process env wins over .env; pollMs floors at 1000; outputLines clamps to 80", () => {
  const configDir = dir({ ".env": "MM_URL=https://a\nMM_POLL_MS=10\nMM_OUTPUT_LINES=500\n" });
  const c = loadConfig({ env: { MM_URL: "https://b" }, root: dir(), configDir, stateDir: dir() });
  assert.equal(c.url, "https://b");
  assert.equal(c.pollMs, 1000);
  assert.equal(c.outputLines, 80);
});

test("channelConfig: channels.json by id or team/name beats the header marker; header marker beats nothing", () => {
  const configDir = dir({ "channels.json": JSON.stringify({ abc: { kind: "codex" }, "home/infra": { cwd: "/srv" } }) });
  const c = loadConfig({ env: {}, root: dir(), configDir, stateDir: dir() });
  assert.deepEqual(c.channelConfig("abc", "herdr: kind=claude", "home/other"), { kind: "codex" });
  assert.deepEqual(c.channelConfig("zzz", "", "home/infra"), { cwd: "/srv" });
  assert.deepEqual(c.channelConfig("zzz", "notes\nherdr: cwd=~/x", "home/other"), { cwd: "~/x" });
  assert.equal(c.channelConfig("zzz", "plain header", "home/other"), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL, cannot find `../src/config.js`.

- [ ] **Step 3: Implement config.js**

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add config loader with MM_* keys"
```

---

### Task 4: starter.js — directives, label, slug

**Files:**
- Create: `src/starter.js`, `test/starter.test.js`

**Interfaces:**
- Produces: `parseStarter(content) -> { kind?, cwd?, machine?, prompt }`, `tabLabel(prompt) -> string`, `slugify(label, taken: Set<string>) -> string` (prefix `mm-`, ≤31 chars, unique against `taken`).

- [ ] **Step 1: Write the failing test**

`test/starter.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { parseStarter, tabLabel, slugify } from "../src/starter.js";

test("directive lines are pulled out; the rest is the prompt", () => {
  const r = parseStarter("kind:codex\ncwd:/srv/x\nmachine:gpu\nfix the build\nplease");
  assert.deepEqual(r, { kind: "codex", cwd: "/srv/x", machine: "gpu", prompt: "fix the build\nplease" });
});

test("no directives → just the trimmed prompt; null content → empty prompt", () => {
  assert.deepEqual(parseStarter("  hello  "), { prompt: "hello" });
  assert.deepEqual(parseStarter(null), { prompt: "" });
});

test("tabLabel is the first non-empty line, capped at 60 chars, 'agent' when empty", () => {
  assert.equal(tabLabel("\n\nFix login bug\nmore"), "Fix login bug");
  assert.equal(tabLabel("x".repeat(100)).length, 60);
  assert.equal(tabLabel(""), "agent");
});

test("slugify prefixes mm-, lowercases, dedupes against taken names, caps at 31", () => {
  assert.equal(slugify("Fix Login Bug!", new Set()), "mm-fix-login-bug");
  assert.equal(slugify("Fix Login Bug!", new Set(["mm-fix-login-bug"])), "mm-fix-login-bug-2");
  assert.equal(slugify("", new Set()), "mm-agent");
  assert.ok(slugify("a".repeat(80), new Set()).length <= 31);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/starter.test.js` → FAIL, module not found.

- [ ] **Step 3: Implement starter.js**

```js
// Directive lines in a root post: `kind:codex`, `cwd:/path`, `machine:gpu-box`.
export function parseStarter(content) {
  const directives = {};
  const rest = [];
  for (const line of (content ?? "").split("\n")) {
    const m = line.trim().match(/^(kind|cwd|machine)\s*:\s*(\S+)\s*$/i);
    if (m) directives[m[1].toLowerCase()] = m[2];
    else rest.push(line);
  }
  return { ...directives, prompt: rest.join("\n").trim() };
}

export function tabLabel(prompt) {
  const line = (prompt ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return (line ?? "agent").slice(0, 60);
}

export function slugify(label, taken) {
  const base = `mm-${(label ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")}`
    .slice(0, 31)
    .replace(/-+$/, "");
  let candidate = base === "mm" ? "mm-agent" : base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${candidate.slice(0, 28).replace(/-+$/, "")}-${i}`;
  return candidate;
}
```

- [ ] **Step 4: Run the tests** → `npm test` all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add starter post parsing"
```

---

### Task 5: chunk.js — fence-safe chunking

**Files:**
- Create: `src/chunk.js`, `test/chunk.test.js`

**Interfaces:**
- Produces: `POST_LIMIT = 16000`; `sanitize(text)` (neutralizes ``` inside output); `fenced(body) -> "```text\n" + body + "\n```"`; `chunks(text, limit = POST_LIMIT) -> string[]` of *unfenced* bodies each of which fences to ≤ limit; `canAppend(body, addition, limit = POST_LIMIT) -> boolean`.

- [ ] **Step 1: Write the failing test**

`test/chunk.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { POST_LIMIT, sanitize, fenced, chunks, canAppend } from "../src/chunk.js";

const FENCE_OVERHEAD = fenced("").length;

test("sanitize neutralizes code fences inside output", () => {
  assert.ok(!sanitize("```js\nfoo\n```").includes("```"));
  assert.equal(sanitize("plain"), "plain");
});

test("short text is one chunk; splitting prefers line boundaries", () => {
  assert.deepEqual(chunks("a\nb"), ["a\nb"]);
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(100)}`);
  const parts = chunks(lines.join("\n"), 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(fenced(p).length <= 1000, `chunk too long: ${fenced(p).length}`);
    assert.ok(!p.startsWith("\n") && !p.endsWith("\n"));
  }
  assert.equal(parts.join("\n"), lines.join("\n"));
});

test("hard-splits a single overlong line", () => {
  const long = "y".repeat(5000);
  const parts = chunks(long, 1000);
  assert.ok(parts.length >= 5);
  for (const p of parts) assert.ok(fenced(p).length <= 1000);
  assert.equal(parts.join(""), long);
});

test("empty text yields a single '(empty)' chunk", () => {
  assert.deepEqual(chunks(""), ["(empty)"]);
});

test("canAppend accounts for the fence and the joining newline", () => {
  const body = "x".repeat(POST_LIMIT - FENCE_OVERHEAD - 2);
  assert.equal(canAppend(body, "a"), true);   // body + "\n" + "a" fits exactly
  assert.equal(canAppend(body, "ab"), false);
});
```

- [ ] **Step 2: Run it to verify it fails** → module not found.

- [ ] **Step 3: Implement chunk.js**

```js
export const POST_LIMIT = 16000;
const ZWSP = "​";

// Output lines may contain ``` which would close our code block.
export function sanitize(text) {
  return text.replace(/```/g, "`" + ZWSP + "`" + ZWSP + "`");
}

export function fenced(body) {
  return "```text\n" + body + "\n```";
}

const overhead = fenced("").length;

export function canAppend(body, addition, limit = POST_LIMIT) {
  return overhead + body.length + 1 + addition.length <= limit;
}

// Split unfenced text so each piece fences to <= limit. Prefer line
// boundaries; hard-split lines that are themselves too long.
export function chunks(text, limit = POST_LIMIT) {
  const max = limit - overhead;
  if (!text) return ["(empty)"];
  const out = [];
  let cur = "";
  const push = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > max) {
      push();
      out.push(line.slice(0, max));
      line = line.slice(max);
    }
    if (!cur) cur = line;
    else if (cur.length + 1 + line.length <= max) cur += "\n" + line;
    else { push(); cur = line; }
  }
  push();
  return out.length ? out : ["(empty)"];
}
```

- [ ] **Step 4: Run the tests** → all pass. If "hard-splits" joins with `""` but your pieces include boundary newlines, re-check: hard-split pieces are pushed without newlines, so `join("")` reconstructs the single line.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add fence-safe post chunking"
```

---

### Task 6: reactions.js — prompt post plan and emoji → keys

**Files:**
- Create: `src/reactions.js`, `test/reactions.test.js`

**Interfaces:**
- Consumes: `parsePrompt`, `keysForOption` from `src/prompts.js`.
- Produces: `NUMBER_EMOJI` (10 names); `promptPlan(parsed, agentName) -> { text, reactions: [{ emoji, keys: string[], label }] }`; `keysForReaction(plan, emoji) -> { keys, label } | null`.

- [ ] **Step 1: Write the failing test**

`test/reactions.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { promptPlan, keysForReaction, NUMBER_EMOJI } from "../src/reactions.js";
import { parsePrompt } from "../src/prompts.js";

test("numbered menu → one numbered reaction per option, keys from the cursor row", () => {
  const parsed = parsePrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No\n  3. Always");
  const plan = promptPlan(parsed, "mm-x");
  assert.equal(plan.reactions.length, 3);
  assert.deepEqual(plan.reactions.map((r) => r.emoji), NUMBER_EMOJI.slice(0, 3));
  assert.deepEqual(keysForReaction(plan, "two"), { keys: ["down", "enter"], label: "2. No" });
  assert.match(plan.text, /1\. Yes/);
  assert.match(plan.text, /mm-x/);
});

test("y/n → check and x; unknown → Enter/Esc", () => {
  const yn = promptPlan(parsePrompt("Continue? [y/n]"), "a");
  assert.deepEqual(keysForReaction(yn, "white_check_mark"), { keys: ["y"], label: "Yes" });
  assert.deepEqual(keysForReaction(yn, "x"), { keys: ["n"], label: "No" });
  const un = promptPlan(parsePrompt("something odd"), "a");
  assert.deepEqual(keysForReaction(un, "white_check_mark").keys, ["enter"]);
  assert.deepEqual(keysForReaction(un, "x").keys, ["esc"]);
});

test("unrelated emoji → null; more than 10 options are capped", () => {
  const plan = promptPlan(parsePrompt("x"), "a");
  assert.equal(keysForReaction(plan, "tada"), null);
  const many = Array.from({ length: 15 }, (_, i) => `  ${i + 1}. opt${i + 1}`).join("\n");
  assert.equal(promptPlan(parsePrompt(many), "a").reactions.length, 10);
});
```

- [ ] **Step 2: Run it to verify it fails** → module not found.

- [ ] **Step 3: Implement reactions.js**

```js
import { keysForOption } from "./prompts.js";

export const NUMBER_EMOJI = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "keycap_ten"];

// Build the prompt post for a blocked agent and the emoji → keys table the
// bot adds as reactions. The user taps a reaction (or replies in the thread).
export function promptPlan(parsed, agentName) {
  const reactions = [];
  const lines = [`🛑 \`${agentName}\` needs input — react below or reply in this thread:`];
  if (parsed.type === "options") {
    parsed.options.slice(0, NUMBER_EMOJI.length).forEach((opt, i) => {
      const label = `${opt.num}. ${opt.label}`;
      lines.push(`:${NUMBER_EMOJI[i]}: ${label}`);
      reactions.push({ emoji: NUMBER_EMOJI[i], keys: keysForOption(parsed, opt.index), label });
    });
  } else if (parsed.type === "yesno") {
    lines.push(":white_check_mark: Yes · :x: No");
    reactions.push({ emoji: "white_check_mark", keys: ["y"], label: "Yes" });
    reactions.push({ emoji: "x", keys: ["n"], label: "No" });
  } else {
    lines.push(":white_check_mark: Approve (Enter) · :x: Cancel (Esc)");
    reactions.push({ emoji: "white_check_mark", keys: ["enter"], label: "Approve (Enter)" });
    reactions.push({ emoji: "x", keys: ["esc"], label: "Cancel (Esc)" });
  }
  return { text: lines.join("\n"), reactions };
}

export function keysForReaction(plan, emoji) {
  const r = (plan?.reactions ?? []).find((x) => x.emoji === emoji);
  return r ? { keys: r.keys, label: r.label } : null;
}
```

- [ ] **Step 4: Run the tests** → all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add reaction-based prompt plans"
```

---

### Task 7: catchup.js — new user posts after reconnect

**Files:**
- Create: `src/catchup.js`, `test/catchup.test.js`

**Interfaces:**
- Produces: `newUserPosts(posts, { since, botUserId }) -> post[]` — posts with `create_at > since`, `user_id !== botUserId`, `type === ""`, sorted ascending by `create_at`. Accepts either an array of posts or Mattermost's `{ order, posts }` thread payload.

- [ ] **Step 1: Write the failing test**

`test/catchup.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { newUserPosts } from "../src/catchup.js";

const p = (id, create_at, user_id = "u", type = "") => ({ id, create_at, user_id, type, message: id });

test("excludes posts at or before since, bot posts, and system posts; sorts ascending", () => {
  const posts = [p("c", 30), p("a", 10), p("bot", 40, "bot"), p("sys", 50, "u", "system_join_channel"), p("b", 20)];
  const out = newUserPosts(posts, { since: 10, botUserId: "bot" });
  assert.deepEqual(out.map((x) => x.id), ["b", "c"]);
});

test("ignores the bot's own user id even with since = 0", () => {
  assert.deepEqual(newUserPosts([p("x", 5, "bot")], { since: 0, botUserId: "bot" }), []);
});

test("accepts the {order, posts} thread payload shape", () => {
  const payload = { order: ["b", "a"], posts: { a: p("a", 1), b: p("b", 2) } };
  assert.deepEqual(newUserPosts(payload, { since: 0, botUserId: "bot" }).map((x) => x.id), ["a", "b"]);
});
```

- [ ] **Step 2: Run it to verify it fails** → module not found.

- [ ] **Step 3: Implement catchup.js**

```js
// After a websocket (re)connect, posts that arrived while disconnected are
// fetched per thread; this picks the ones the bot still has to act on.
export function newUserPosts(payload, { since = 0, botUserId }) {
  const posts = Array.isArray(payload) ? payload : Object.values(payload?.posts ?? {});
  return posts
    .filter((p) => p.create_at > since && p.user_id !== botUserId && (p.type ?? "") === "")
    .sort((a, b) => a.create_at - b.create_at);
}
```

- [ ] **Step 4: Run the tests** → all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add reconnect catch-up filter"
```

---

### Task 8: mattermost.js — REST + websocket client

**Files:**
- Create: `src/mattermost.js`, `test/mattermost.test.js`

**Interfaces:**
- Produces: `class MattermostClient` and `class MattermostError extends Error { status, body }`.
  ```js
  new MattermostClient({ url, token, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = console })
  client.userId                                   // set by connect()/me()
  await client.api(method, path, body?)           // JSON in/out; throws MattermostError on !ok
  await client.me()                               // GET /users/me, sets userId
  await client.teamByName(name)                   // GET /teams/name/{name}
  await client.userByUsername(name)               // GET /users/username/{name}
  await client.channel(id)                        // GET /channels/{id} (header, purpose, name, team_id)
  await client.channelByName(teamId, name)        // GET /teams/{teamId}/channels/name/{name}
  await client.createPost({ channelId, rootId = "", message }) // POST /posts → post
  await client.editPost(id, message)              // PUT /posts/{id}/patch → post
  await client.threadPosts(rootId, since = 0)     // GET /posts/{rootId}/thread?since= → {order, posts}
  await client.addReaction(postId, emoji)         // POST /reactions {user_id: userId, post_id, emoji_name}
  await client.removeReaction(postId, emoji)      // DELETE /users/{userId}/posts/{postId}/reactions/{emoji}
  await client.fileInfo(fileId)                   // GET /files/{id}/info → {name, size}
  await client.downloadFile(fileId, destPath)     // GET /files/{id} → writes bytes
  client.connect({ onPosted(post, data), onReaction(reaction), onConnected() }) // returns { close() }
  ```
  `connect` sends `authentication_challenge`, dispatches `posted` (with `data.post` parsed) and `reaction_added` (with `data.reaction` parsed), calls `onConnected` after each successful auth (`hello` received), and reconnects with backoff 1s → 60s on close/error until `close()` is called.

- [ ] **Step 1: Write the failing test**

`test/mattermost.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { MattermostClient, MattermostError } from "../src/mattermost.js";

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const key = `${init.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`;
    const r = routes[key] ?? routes[`${init.method ?? "GET"} ${new URL(url).pathname}`];
    if (!r) return { ok: false, status: 404, text: async () => "no route " + key, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r), arrayBuffer: async () => new TextEncoder().encode("bytes").buffer };
  };
  return { fetchImpl, calls };
}

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.instances.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

test("api sends the bearer token and throws MattermostError on failure", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET /api/v4/users/me": { id: "bot1", username: "herdr" } });
  const c = new MattermostClient({ url: "https://mm.test", token: "tok", fetchImpl, WebSocketImpl: FakeWS });
  const me = await c.me();
  assert.equal(me.id, "bot1");
  assert.equal(c.userId, "bot1");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  await assert.rejects(() => c.api("GET", "/nope"), (e) => e instanceof MattermostError && e.status === 404);
});

test("createPost/editPost/reactions hit the documented endpoints with the right bodies", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST /api/v4/posts": { id: "p1" },
    "PUT /api/v4/posts/p1/patch": { id: "p1", message: "edited" },
    "POST /api/v4/reactions": {},
    "DELETE /api/v4/users/bot1/posts/p1/reactions/one": {},
    "GET /api/v4/posts/root/thread?since=5": { order: [], posts: {} },
  });
  const c = new MattermostClient({ url: "https://mm.test", token: "t", fetchImpl, WebSocketImpl: FakeWS });
  c.userId = "bot1";
  const post = await c.createPost({ channelId: "ch", rootId: "root", message: "hi" });
  assert.equal(post.id, "p1");
  assert.deepEqual(calls[0].body, { channel_id: "ch", root_id: "root", message: "hi" });
  await c.editPost("p1", "edited");
  assert.deepEqual(calls[1].body, { message: "edited" });
  await c.addReaction("p1", "one");
  assert.deepEqual(calls[2].body, { user_id: "bot1", post_id: "p1", emoji_name: "one" });
  await c.removeReaction("p1", "one");
  assert.equal(calls[3].method, "DELETE");
  await c.threadPosts("root", 5);
  assert.match(calls[4].url, /\/posts\/root\/thread\?since=5$/);
});

test("connect authenticates, parses posted/reaction events, and reconnects after close", async () => {
  const { fetchImpl } = fakeFetch({});
  FakeWS.instances = [];
  const c = new MattermostClient({ url: "https://mm.test", token: "t", fetchImpl, WebSocketImpl: FakeWS, log: { error() {}, log() {} }, backoff: { base: 1, max: 2 } });
  const seen = { posted: [], reactions: [], connected: 0 };
  const h = c.connect({
    onPosted: (post, data) => seen.posted.push([post, data.channel_name]),
    onReaction: (r) => seen.reactions.push(r),
    onConnected: () => seen.connected++,
  });
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, "wss://mm.test/api/v4/websocket");
  ws.open();
  assert.deepEqual(ws.sent[0], { seq: 1, action: "authentication_challenge", data: { token: "t" } });
  ws.emit({ event: "hello", data: {}, seq: 0 });
  assert.equal(seen.connected, 1);
  ws.emit({ event: "posted", data: { channel_name: "dev", post: JSON.stringify({ id: "p", message: "m", root_id: "" }) }, seq: 1 });
  assert.deepEqual(seen.posted, [[{ id: "p", message: "m", root_id: "" }, "dev"]]);
  ws.emit({ event: "reaction_added", data: { reaction: JSON.stringify({ post_id: "p", emoji_name: "one", user_id: "u" }) }, seq: 2 });
  assert.equal(seen.reactions[0].emoji_name, "one");
  ws.onclose({ code: 1006 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWS.instances.length, 2, "reconnected");
  h.close();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(FakeWS.instances.length, 2, "no reconnect after close()");
});
```

- [ ] **Step 2: Run it to verify it fails** → module not found.

- [ ] **Step 3: Implement mattermost.js**

```js
import { writeFile } from "node:fs/promises";

export class MattermostError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class MattermostClient {
  constructor({ url, token, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, log = console, backoff = { base: 1000, max: 60000 } }) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.log = log;
    this.backoff = backoff;
    this.userId = null;
  }

  async api(method, path, body) {
    const res = await this.fetch(`${this.url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new MattermostError(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`, res.status, text);
    }
    return res.json();
  }

  async me() {
    const u = await this.api("GET", "/users/me");
    this.userId = u.id;
    return u;
  }
  teamByName(name) { return this.api("GET", `/teams/name/${encodeURIComponent(name)}`); }
  userByUsername(name) { return this.api("GET", `/users/username/${encodeURIComponent(name)}`); }
  channel(id) { return this.api("GET", `/channels/${id}`); }
  channelByName(teamId, name) { return this.api("GET", `/teams/${teamId}/channels/name/${encodeURIComponent(name)}`); }
  createPost({ channelId, rootId = "", message }) {
    return this.api("POST", "/posts", { channel_id: channelId, root_id: rootId, message });
  }
  editPost(id, message) { return this.api("PUT", `/posts/${id}/patch`, { message }); }
  threadPosts(rootId, since = 0) { return this.api("GET", `/posts/${rootId}/thread?since=${since}`); }
  addReaction(postId, emoji) {
    return this.api("POST", "/reactions", { user_id: this.userId, post_id: postId, emoji_name: emoji });
  }
  removeReaction(postId, emoji) {
    return this.api("DELETE", `/users/${this.userId}/posts/${postId}/reactions/${emoji}`);
  }
  fileInfo(fileId) { return this.api("GET", `/files/${fileId}/info`); }
  async downloadFile(fileId, destPath) {
    const res = await this.fetch(`${this.url}/api/v4/files/${fileId}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new MattermostError(`GET /files/${fileId} → ${res.status}`, res.status, "");
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return destPath;
  }

  // Websocket with authentication_challenge, event parsing and reconnect.
  connect({ onPosted, onReaction, onConnected }) {
    let closed = false;
    let delay = this.backoff.base;
    let ws = null;
    const wsUrl = this.url.replace(/^http/, "ws") + "/api/v4/websocket";

    const open = () => {
      if (closed) return;
      ws = new this.WebSocket(wsUrl);
      let authed = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: this.token } }));
      };
      ws.onmessage = (m) => {
        let e;
        try { e = JSON.parse(m.data); } catch { return; }
        if (e.event === "hello") {
          authed = true;
          delay = this.backoff.base;
          onConnected?.();
          return;
        }
        if (!authed) return;
        try {
          if (e.event === "posted") onPosted?.(JSON.parse(e.data.post), e.data);
          else if (e.event === "reaction_added") onReaction?.(JSON.parse(e.data.reaction));
        } catch (err) {
          this.log.error(`herdr-mattermost: event handler failed: ${err.message}`);
        }
      };
      ws.onerror = (err) => this.log.error(`herdr-mattermost: websocket error: ${err?.message ?? err}`);
      ws.onclose = () => {
        if (closed) return;
        this.log.error(`herdr-mattermost: websocket closed; reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(open, delay);
        delay = Math.min(delay * 2, this.backoff.max);
      };
    };
    open();
    return {
      close() {
        closed = true;
        try { ws?.close(); } catch {}
      },
    };
  }
}
```

- [ ] **Step 4: Run the tests** → `npm test` all pass. If the reconnect test is flaky on timing, raise the two `setTimeout(r, 10)` waits to 50.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add Mattermost REST and websocket client"
```

---

### Task 9: output.js — append-in-place relay writer

**Files:**
- Create: `src/output.js`, `test/output.test.js`

**Interfaces:**
- Consumes: `MattermostClient.createPost/editPost`, `chunks`, `fenced`, `canAppend`, `sanitize` from `src/chunk.js`.
- Produces:
  ```js
  new OutputWriter({ mm, limit = POST_LIMIT })
  await writer.append(threadKey, { channelId, rootId }, text)  // text = lines joined by "\n"
  writer.reset(threadKey)   // next append starts a new post
  writer.drop(threadKey)
  ```
  `threadKey` is the root post id. The writer keeps `{ postId, body }` per thread in memory only; after a bot restart the first append starts a fresh post.

- [ ] **Step 1: Write the failing test**

`test/output.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { OutputWriter } from "../src/output.js";
import { fenced } from "../src/chunk.js";

function fakeMM() {
  const posts = [];
  let n = 0;
  return {
    posts,
    async createPost({ channelId, rootId, message }) { const p = { id: `p${++n}`, channelId, rootId, message }; posts.push(p); return p; },
    async editPost(id, message) { const p = posts.find((x) => x.id === id); p.message = message; p.edits = (p.edits ?? 0) + 1; return p; },
  };
}

const where = { channelId: "ch", rootId: "root" };

test("first append creates a fenced post; later appends edit it in place", async () => {
  const mm = fakeMM();
  const w = new OutputWriter({ mm, limit: 200 });
  await w.append("root", where, "line 1");
  await w.append("root", where, "line 2\nline 3");
  assert.equal(mm.posts.length, 1);
  assert.equal(mm.posts[0].message, fenced("line 1\nline 2\nline 3"));
  assert.equal(mm.posts[0].rootId, "root");
});

test("a new post starts when the next append would exceed the limit", async () => {
  const mm = fakeMM();
  const w = new OutputWriter({ mm, limit: 60 });
  await w.append("root", where, "a".repeat(30));
  await w.append("root", where, "b".repeat(30));
  assert.equal(mm.posts.length, 2);
  for (const p of mm.posts) assert.ok(p.message.length <= 60);
});

test("reset forces a new post; sanitize keeps fences intact; overlong text is chunked across posts", async () => {
  const mm = fakeMM();
  const w = new OutputWriter({ mm, limit: 100 });
  await w.append("root", where, "```bash");
  assert.ok(!mm.posts[0].message.slice(8, -4).includes("```"));
  w.reset("root");
  await w.append("root", where, "x".repeat(250));
  assert.ok(mm.posts.length >= 4);
  for (const p of mm.posts) assert.ok(p.message.length <= 100);
});
```

- [ ] **Step 2: Run it to verify it fails** → module not found.

- [ ] **Step 3: Implement output.js**

```js
import { POST_LIMIT, chunks, fenced, canAppend, sanitize } from "./chunk.js";

// Relay output lands in as few posts as possible: append to the thread's
// current output post by editing it, start a new one when it is full.
export class OutputWriter {
  constructor({ mm, limit = POST_LIMIT }) {
    this.mm = mm;
    this.limit = limit;
    this.current = new Map(); // threadKey -> { postId, body }
  }

  async append(threadKey, { channelId, rootId }, text) {
    const clean = sanitize(text.replace(/\r/g, ""));
    if (!clean.trim()) return;
    const cur = this.current.get(threadKey);
    if (cur && canAppend(cur.body, clean, this.limit)) {
      cur.body = `${cur.body}\n${clean}`;
      await this.mm.editPost(cur.postId, fenced(cur.body));
      return;
    }
    const parts = chunks(clean, this.limit);
    let last = null;
    for (const part of parts) {
      last = { postId: (await this.mm.createPost({ channelId, rootId, message: fenced(part) })).id, body: part };
    }
    this.current.set(threadKey, last);
  }

  reset(threadKey) { this.current.delete(threadKey); }
  drop(threadKey) { this.current.delete(threadKey); }
}
```

- [ ] **Step 4: Run the tests** → all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add append-in-place output writer"
```

---

### Task 10: thread-input.js — prompt routing adapted to Mattermost

**Files:**
- Create: `src/thread-input.js`, `test/thread-input.test.js`

**Interfaces:**
- Consumes: `midTurnStrategy` (Task 2); `herdr.promptAgent/sendText/sendKeys`.
- Produces:
  ```js
  await handleUserText({ post, mapping, text, prompt, mm, herdr, persist })
  await flushQueue(mapping, mm, herdr, persist)
  ```
  `post` is a Mattermost post (`id`, `channel_id`, `root_id`); replies go to `mm.createPost({ channelId: post.channel_id, rootId: mapping.root_id, message })`; acks are `mm.addReaction(post.id, emoji)`. Status semantics: `gone` → reply and stop; `!!raw` → `sendText` + Enter, react `zap`; **`blocked` → plain text is the answer: `sendText` + Enter, react `keyboard`**; `idle`/`done`, or `working` with a `queue` kind → `promptAgent`, react `white_check_mark` (`inbox_tray` when working); otherwise hold in `mapping.queue` with `hourglass_flowing_sand`. `flushQueue` sends FIFO, swapping `hourglass_flowing_sand` for `white_check_mark` on each held post. Held entries are `{ id: post.id, text: prompt }`.

- [ ] **Step 1: Write the failing test**

`test/thread-input.test.js`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { handleUserText, flushQueue } from "../src/thread-input.js";

function fakeMM() {
  const out = { posts: [], reactions: [], removed: [] };
  return {
    out,
    async createPost({ rootId, message }) { out.posts.push({ rootId, message }); return { id: "r" }; },
    async addReaction(postId, emoji) { out.reactions.push([postId, emoji]); },
    async removeReaction(postId, emoji) { out.removed.push([postId, emoji]); },
  };
}
function fakeHerdr(overrides = {}) {
  const calls = { prompt: [], sendText: [], sendKeys: [] };
  return { calls, herdr: {
    promptAgent: async (...a) => calls.prompt.push(a),
    sendText: async (...a) => calls.sendText.push(a),
    sendKeys: async (...a) => calls.sendKeys.push(a),
    ...overrides,
  } };
}
const post = { id: "m1", channel_id: "ch", root_id: "root" };
const mapping = (over = {}) => ({ root_id: "root", agent_name: "mm-a", pane_id: "pane", kind: "claude", machine: null, last_status: "idle", ...over });

test("idle agent: prompt is sent and the post gets a check reaction", async () => {
  const mm = fakeMM(); const { calls, herdr } = fakeHerdr();
  await handleUserText({ post, mapping: mapping(), text: "hi", prompt: "fzf: hi", mm, herdr, persist() {} });
  assert.deepEqual(calls.prompt, [["mm-a", "fzf: hi", null]]);
  assert.deepEqual(mm.out.reactions, [["m1", "white_check_mark"]]);
});

test("working non-queue kind holds the prompt; flushQueue sends it and swaps the reaction", async () => {
  const mm = fakeMM(); const { calls, herdr } = fakeHerdr();
  const m = mapping({ kind: "omp", last_status: "working" });
  let persisted = 0;
  await handleUserText({ post, mapping: m, text: "hi", prompt: "fzf: hi", mm, herdr, persist: () => persisted++ });
  assert.equal(calls.prompt.length, 0);
  assert.deepEqual(m.queue, [{ id: "m1", text: "fzf: hi" }]);
  assert.deepEqual(mm.out.reactions, [["m1", "hourglass_flowing_sand"]]);
  assert.ok(persisted > 0);
  assert.match(mm.out.posts[0].message, /holding until it settles/);
  await flushQueue(m, mm, herdr, () => persisted++);
  assert.deepEqual(calls.prompt, [["mm-a", "fzf: hi", null]]);
  assert.deepEqual(mm.out.removed, [["m1", "hourglass_flowing_sand"]]);
  assert.deepEqual(mm.out.reactions.at(-1), ["m1", "white_check_mark"]);
  assert.deepEqual(m.queue, []);
});

test("blocked agent: a plain reply is typed in as the answer", async () => {
  const mm = fakeMM(); const { calls, herdr } = fakeHerdr();
  await handleUserText({ post, mapping: mapping({ last_status: "blocked" }), text: "use the second one", prompt: "fzf: use the second one", mm, herdr, persist() {} });
  assert.deepEqual(calls.sendText, [["pane", "use the second one", null]]);
  assert.deepEqual(calls.sendKeys, [["mm-a", ["enter"], null]]);
  assert.deepEqual(mm.out.reactions, [["m1", "keyboard"]]);
  assert.equal(calls.prompt.length, 0);
});

test("!! raw passthrough types text + Enter regardless of state; bare !! explains itself", async () => {
  const mm = fakeMM(); const { calls, herdr } = fakeHerdr();
  await handleUserText({ post, mapping: mapping({ last_status: "working", kind: "omp" }), text: "!!/btw hi", prompt: "x", mm, herdr, persist() {} });
  assert.deepEqual(calls.sendText, [["pane", "/btw hi", null]]);
  assert.deepEqual(mm.out.reactions, [["m1", "zap"]]);
  await handleUserText({ post, mapping: mapping(), text: "!!", prompt: "x", mm, herdr, persist() {} });
  assert.match(mm.out.posts.at(-1).message, /types raw input/);
});

test("gone agent: reply and do nothing", async () => {
  const mm = fakeMM(); const { calls, herdr } = fakeHerdr();
  await handleUserText({ post, mapping: mapping({ last_status: "gone" }), text: "hi", prompt: "x", mm, herdr, persist() {} });
  assert.equal(calls.prompt.length, 0);
  assert.match(mm.out.posts[0].message, /no longer running/);
});

test("agent_blocked race: prompt is held", async () => {
  const mm = fakeMM();
  const { herdr } = fakeHerdr({ promptAgent: async () => { const e = new Error("blocked"); e.code = "agent_blocked"; throw e; } });
  const m = mapping();
  await handleUserText({ post, mapping: m, text: "hi", prompt: "x", mm, herdr, persist() {} });
  assert.deepEqual(m.queue, [{ id: "m1", text: "x" }]);
  assert.deepEqual(mm.out.reactions, [["m1", "hourglass_flowing_sand"]]);
});
```

- [ ] **Step 2: Run it to verify it fails** → module not found.

- [ ] **Step 3: Implement thread-input.js**

```js
import { midTurnStrategy } from "./capabilities.js";

const reply = (mm, post, mapping, message) =>
  mm.createPost({ channelId: post.channel_id, rootId: mapping.root_id, message }).catch(() => {});
const react = (mm, post, emoji) => mm.addReaction(post.id, emoji).catch(() => {});

export async function handleUserText({ post, mapping, text, prompt, mm, herdr, persist }) {
  const status = mapping.last_status;
  if (status === "gone") {
    await reply(mm, post, mapping, `Agent \`${mapping.agent_name}\` is no longer running.`);
    return;
  }

  if (text.startsWith("!!")) {
    const raw = text.slice(2);
    if (!raw) {
      await reply(mm, post, mapping, "`!!` types raw input into the agent's pane — e.g. `!!/btw status?`");
      return;
    }
    try {
      await herdr.sendText(mapping.pane_id, raw, mapping.machine);
      await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
      await react(mm, post, "zap");
    } catch (err) {
      await reply(mm, post, mapping, `Raw send failed: ${err.message}`);
    }
    return;
  }

  if (status === "blocked") {
    // The agent is waiting on a dialog: a plain reply is the answer.
    try {
      await herdr.sendText(mapping.pane_id, text, mapping.machine);
      await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
      await react(mm, post, "keyboard");
    } catch (err) {
      await reply(mm, post, mapping, `Couldn't type the answer: ${err.message}`);
    }
    return;
  }

  const settled = status === "idle" || status === "done";
  const canSendNow = settled || (status === "working" && midTurnStrategy(mapping.kind) === "queue");
  if (!canSendNow) {
    (mapping.queue ??= []).push({ id: post.id, text: prompt });
    if (!mapping.queue_explained) {
      mapping.queue_explained = true;
      await reply(mm, post, mapping,
        `\`${mapping.kind}\` can't take input mid-turn — holding until it settles. \`!!text\` sends raw input immediately.`);
    }
    persist();
    await react(mm, post, "hourglass_flowing_sand");
    return;
  }
  try {
    await herdr.promptAgent(mapping.agent_name, prompt, mapping.machine);
    await react(mm, post, status === "working" ? "inbox_tray" : "white_check_mark");
  } catch (err) {
    if (err.code === "agent_blocked") {
      (mapping.queue ??= []).push({ id: post.id, text: prompt });
      persist();
      await react(mm, post, "hourglass_flowing_sand");
    } else {
      throw err;
    }
  }
}

// Send held prompts FIFO once the agent settles; swap ⏳ for ✅ on each.
export async function flushQueue(mapping, mm, herdr, persist) {
  const queue = mapping.queue ?? [];
  while (queue.length) {
    const entry = queue[0];
    try {
      await herdr.promptAgent(mapping.agent_name, entry.text, mapping.machine);
    } catch (err) {
      await mm.createPost({ channelId: mapping.channel_id, rootId: mapping.root_id,
        message: `Couldn't send a held message: ${err.message} — ${queue.length} still queued.` }).catch(() => {});
      return;
    }
    queue.shift();
    persist();
    if (entry.id) {
      await mm.removeReaction(entry.id, "hourglass_flowing_sand").catch(() => {});
      await mm.addReaction(entry.id, "white_check_mark").catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run the tests** → all pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Adapt thread input routing to Mattermost posts and reactions"
```

---

### Task 11: bot.js — orchestration with injected dependencies

**Files:**
- Create: `src/bot.js`
- Modify: `src/mattermost.js` (add `user(id)`)

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces:
  ```js
  createBot({ config, mm, herdr, state, saveState, output, relay, team: { id, name }, allowed: Set<userId>, log = console })
    -> { start(), stop(), handlePosted(post, data|null), handleReaction(reaction), poll(), catchUp() }
  ```
  `mm.userId` must already be set (main calls `mm.me()` first). `allowed` holds resolved user ids. Thread mappings live in `state.threads[rootPostId]` with the fields listed in the spec plus `root_id` and `channel_id`; `state.channels[channelId] = { bound, machine, workspace_id }`.

  This task has no test of its own; Task 12 tests it end to end with fakes. Implement it in full now so Task 12's tests have something to run against.

- [ ] **Step 1: Add `user(id)` to the client**

In `src/mattermost.js`, after `userByUsername`, add:
```js
  user(id) { return this.api("GET", `/users/${id}`); }
```

- [ ] **Step 2: Write bot.js**

```js
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parsePrompt } from "./prompts.js";
import { midTurnDescription } from "./capabilities.js";
import { handleUserText, flushQueue } from "./thread-input.js";
import { parseStarter, tabLabel, slugify } from "./starter.js";
import { promptPlan, keysForReaction, NUMBER_EMOJI } from "./reactions.js";
import { newUserPosts } from "./catchup.js";
import { chunks, fenced } from "./chunk.js";

const CHANNEL_TTL_MS = 60_000;

export function createBot({ config, mm, herdr, state, saveState, output, relay, team, allowed, log = console }) {
  const persist = () => saveState(state);
  const botUserId = () => mm.userId;
  const authorized = (userId) => allowed.size === 0 || allowed.has(userId);
  const channelCache = new Map(); // id -> { at, info }
  const userCache = new Map();    // id -> username
  const pendingSetups = new Map(); // post id -> { channelId, machine, options }
  let connection = null;
  let timer = null;

  // ---- helpers -----------------------------------------------------------

  async function channelInfo(id) {
    const hit = channelCache.get(id);
    if (hit && Date.now() - hit.at < CHANNEL_TTL_MS) return hit.info;
    const info = await mm.channel(id);
    channelCache.set(id, { at: Date.now(), info });
    return info;
  }

  // Null when the channel is not watched; {} or the parsed config otherwise.
  async function watchConfig(channelId) {
    const info = await channelInfo(channelId).catch(() => null);
    const header = info ? `${info.header ?? ""}\n${info.purpose ?? ""}` : "";
    const key = info ? `${team.name}/${info.name}` : null;
    return config.channelConfig(channelId, header, key) ?? (state.channels[channelId]?.bound ? {} : null);
  }

  async function userName(id, data) {
    if (data?.sender_name) return data.sender_name.replace(/^@/, "");
    if (userCache.has(id)) return userCache.get(id);
    const u = await mm.user(id).catch(() => null);
    const name = u?.username ?? id;
    userCache.set(id, name);
    return name;
  }

  const say = (channelId, rootId, message) => mm.createPost({ channelId, rootId, message }).catch((e) => log.error(`post failed: ${e.message}`));

  async function postOutput(mapping, text) {
    const body = text.trim() || "(no output)";
    for (const part of chunks(body)) await say(mapping.channel_id, mapping.root_id, fenced(part));
  }

  async function downloadAttachments(post) {
    const paths = [];
    for (const fileId of post.file_ids ?? []) {
      try {
        const info = await mm.fileInfo(fileId);
        const dir = join(config.stateDir, "files");
        mkdirSync(dir, { recursive: true });
        const safe = String(info.name ?? fileId).replace(/[^A-Za-z0-9._-]+/g, "_");
        paths.push(await mm.downloadFile(fileId, join(dir, `${post.id}-${safe}`)));
      } catch (err) {
        log.error(`attachment ${fileId} failed: ${err.message}`);
      }
    }
    return paths;
  }

  async function resolveWorkspace(idOrLabel, machine) {
    const workspaces = await herdr.listWorkspaces(machine).catch(() => []);
    return workspaces.find((w) => w.workspace_id === idOrLabel || w.label === idOrLabel) ?? null;
  }

  function mappingForPrompt(postId) {
    return Object.values(state.threads).find((t) => t.prompt_post_id === postId) ?? null;
  }

  async function clearPrompt(mapping, note) {
    const id = mapping.prompt_post_id;
    if (!id) return;
    for (const r of mapping.prompt_reactions ?? []) await mm.removeReaction(id, r.emoji).catch(() => {});
    if (note) {
      const text = mapping.prompt_text ?? "";
      await mm.editPost(id, `${text}\n— ${note}`).catch(() => {});
    }
    delete mapping.prompt_post_id;
    delete mapping.prompt_reactions;
    delete mapping.prompt_text;
  }

  // ---- root posts → agents ----------------------------------------------

  async function startAgentForPost(post, data) {
    if (!authorized(post.user_id)) return;
    const channelCfg = await watchConfig(post.channel_id);
    if (channelCfg === null) return;

    const channelId = post.channel_id;
    const rootId = post.id;
    try {
      const directives = parseStarter(post.message);
      const files = await downloadAttachments(post);
      const prompt = [directives.prompt, ...files].filter(Boolean).join("\n");
      const kind = directives.kind ?? channelCfg.kind ?? config.agentKind;
      const cwd = directives.cwd ?? channelCfg.cwd ?? config.cwd;
      const chState = (state.channels[channelId] ??= {});
      const machine = directives.machine ?? channelCfg.machine ?? chState.machine ?? null;

      await say(channelId, rootId, `Starting a **${kind}** agent for this thread…`);

      let workspace;
      if (channelCfg.workspace) {
        workspace = await resolveWorkspace(channelCfg.workspace, machine);
        if (!workspace) throw new Error(`workspace "${channelCfg.workspace}" not found${machine ? ` on ${machine}` : ""} — fix the channel header or run \`!setup\``);
      } else {
        const useBound = chState.bound && chState.machine === machine;
        const info = await channelInfo(channelId).catch(() => null);
        workspace = await herdr.ensureWorkspace({
          workspaceId: useBound ? chState.workspace_id : null,
          cwd: channelCfg.cwd ?? config.cwd,
          label: channelCfg.label ?? info?.display_name ?? info?.name ?? `mattermost-${channelId}`,
          machine,
        });
        if (!chState.bound) { chState.machine = machine; chState.workspace_id = workspace.workspace_id; }
      }

      const label = tabLabel(prompt);
      const tab = await herdr.createTab({ workspaceId: workspace.workspace_id, cwd, label, machine });
      const paneId = tab.root_pane?.pane_id ?? tab.pane?.pane_id;
      if (!paneId) throw new Error("tab created but no root pane id in response");

      const existing = new Set((await herdr.listAgents(machine).catch(() => [])).map((a) => a.name ?? a.agent));
      for (const t of Object.values(state.threads)) if ((t.machine ?? null) === machine) existing.add(t.agent_name);
      const name = slugify(label, existing);

      await herdr.startAgent({ name, kind, paneId, machine });

      state.threads[rootId] = {
        root_id: rootId, channel_id: channelId,
        workspace_id: workspace.workspace_id, tab_id: tab.tab?.tab_id, pane_id: paneId,
        agent_name: name, kind, machine, last_status: "starting", last_seen_at: post.create_at ?? Date.now(),
      };
      persist();

      await say(channelId, rootId,
        `Agent \`${name}\` (${kind}) is up — tab \`${tab.tab?.tab_id}\` in workspace \`${workspace.workspace_id}\`${machine ? ` on \`${machine}\`` : ""}.\n` +
        "Reply here to prompt it; output relays here as it runs.\n" +
        `Mid-turn prompts: ${midTurnDescription(kind)} · \`!!text\` sends raw input immediately.\n` +
        "Commands: `!status` `!read [n]` `!queue` `!approve` `!close` `!help`");

      if (prompt && !prompt.startsWith("!")) await herdr.promptAgent(name, prompt, machine);
    } catch (err) {
      log.error("start agent failed:", err);
      await say(channelId, rootId, `Failed to start agent: ${err.message}`);
    }
  }

  // ---- channel commands ---------------------------------------------------

  async function onChannelCommand(post, text) {
    const channelId = post.channel_id;
    const rootId = post.id;
    const [cmd, arg] = text.slice(1).split(/\s+/, 2);
    const chState = state.channels[channelId];
    const watched = async () => (await watchConfig(channelId)) !== null;

    switch (cmd.toLowerCase()) {
      case "setup": {
        if (!authorized(post.user_id)) { await say(channelId, rootId, "You are not on the allowed-users list for this bridge."); return; }
        const machine = arg || (await watchConfig(channelId))?.machine || chState?.machine || null;
        const workspaces = (await herdr.listWorkspaces(machine).catch(() => [])).slice(0, NUMBER_EMOJI.length - 1);
        const options = workspaces.map((w) => ({ workspace_id: w.workspace_id, label: w.label ?? w.workspace_id, cwd: w.cwd ?? "" }));
        options.push({ new: true, label: "New workspace (auto-created on the first post)" });
        const lines = [`Bind this channel to a Herdr workspace${machine ? ` on \`${machine}\`` : ""} — react with a number:`];
        options.forEach((o, i) => lines.push(`:${NUMBER_EMOJI[i]}: ${o.label}${o.cwd ? ` — \`${o.cwd}\`` : ""}`));
        const p = await mm.createPost({ channelId, rootId, message: lines.join("\n") });
        for (let i = 0; i < options.length; i++) await mm.addReaction(p.id, NUMBER_EMOJI[i]).catch(() => {});
        pendingSetups.set(p.id, { channelId, machine, options, text: lines.join("\n") });
        break;
      }
      case "unbind": {
        if (!authorized(post.user_id)) return;
        delete state.channels[channelId];
        persist();
        await say(channelId, rootId, (await watched())
          ? "Workspace binding cleared — the header/channels.json still watch this channel, so new posts auto-create a workspace."
          : "Channel unbound — new posts will no longer spawn agents.");
        break;
      }
      case "status": {
        const lines = [`Channel watched: **${(await watched()) ? "yes" : "no"}**`];
        if (chState?.workspace_id) lines.push(`Workspace: \`${chState.workspace_id}\`${chState.bound ? " (bound via !setup)" : " (auto-created)"}`);
        if (chState?.machine) lines.push(`Machine: \`${chState.machine}\``);
        lines.push(`Mapped threads: ${Object.values(state.threads).filter((t) => t.channel_id === channelId).length}`);
        await say(channelId, rootId, lines.join("\n"));
        break;
      }
      case "help":
        await say(channelId, rootId,
          "`!setup [machine]` bind this channel to a Herdr workspace · `!unbind` clear the binding · `!status` channel state\n" +
          "Or put `herdr:` in the channel header, e.g. `herdr: workspace=my-api kind=claude`. Every other root post starts an agent.");
        break;
      default:
        await say(channelId, rootId, "Unknown command. `!setup [machine]` `!unbind` `!status` `!help`");
    }
  }

  // ---- thread commands ----------------------------------------------------

  async function onThreadCommand(post, mapping, text) {
    const [cmd, arg] = text.slice(1).split(/\s+/, 2);
    const { channel_id: channelId, root_id: rootId } = mapping;
    switch (cmd.toLowerCase()) {
      case "status": {
        const agent = await herdr.getAgent(mapping.agent_name, mapping.machine);
        const status = agent.status ?? agent.agent_status ?? "unknown";
        await say(channelId, rootId,
          `\`${mapping.agent_name}\` (${mapping.kind}) — **${status}**\n` +
          `workspace \`${mapping.workspace_id}\` tab \`${mapping.tab_id}\` pane \`${mapping.pane_id}\`` +
          (mapping.machine ? ` machine \`${mapping.machine}\`` : ""));
        break;
      }
      case "read": {
        const n = Math.min(Math.max(parseInt(arg, 10) || config.outputLines, 1), 80);
        await postOutput(mapping, await herdr.readAgent(mapping.agent_name, { lines: n, machine: mapping.machine }));
        break;
      }
      case "approve":
        await herdr.sendKeys(mapping.agent_name, ["enter"], mapping.machine);
        await mm.addReaction(post.id, "+1").catch(() => {});
        break;
      case "queue": {
        const q = mapping.queue ?? [];
        await say(channelId, rootId, q.length
          ? `Held messages (${q.length}):\n` + q.map((e, i) => `${i + 1}. ${e.text.split("\n")[0].slice(0, 80)}`).join("\n")
          : "No held messages.");
        break;
      }
      case "close":
        await say(channelId, rootId, "Closing the agent tab…");
        if (mapping.tab_id) await herdr.closeTab(mapping.tab_id, mapping.machine).catch(() => {});
        await clearPrompt(mapping, null);
        relay.drop(rootId);
        output.drop(rootId);
        delete state.threads[rootId];
        persist();
        break;
      case "setup":
        await say(channelId, rootId, "`!setup` is a channel command — post it as a new root post in the channel. This thread already has an agent (`!status` to check it).");
        break;
      case "help":
        await say(channelId, rootId,
          "`!status` agent status · `!read [n]` last n output lines · `!queue` held prompts · " +
          "`!approve` send Enter to a blocked agent · `!close` close the agent tab\n" +
          "`!!text` types raw input into the agent right now. While the agent is blocked, a plain reply is typed in as the answer.\n" +
          "Root-post directives (own lines): `kind:<agent>` `cwd:<path>` `machine:<label>`. Channel config goes in the header: `herdr: kind=codex cwd=~/code/x`.");
        break;
      default:
        break; // not a bridge command
    }
  }

  // ---- events ---------------------------------------------------------------

  async function handlePosted(post, data) {
    try {
      if (!post || post.user_id === botUserId()) return;
      if (post.type) return; // system messages
      const text = (post.message ?? "").trim();

      if (!post.root_id) {
        if (text.startsWith("!")) await onChannelCommand(post, text);
        else await startAgentForPost(post, data);
        return;
      }

      const mapping = state.threads[post.root_id];
      if (!mapping) return;
      if (post.create_at > (mapping.last_seen_at ?? 0)) { mapping.last_seen_at = post.create_at; persist(); }
      if (!authorized(post.user_id)) { await say(mapping.channel_id, mapping.root_id, "You are not on the allowed-users list for this bridge."); return; }
      if (text.startsWith("!") && !text.startsWith("!!")) return onThreadCommand(post, mapping, text);

      const files = await downloadAttachments(post);
      const prompt = `${await userName(post.user_id, data)}: ${text}` + (files.length ? `\n${files.join("\n")}` : "");
      await handleUserText({ post, mapping, text, prompt, mm, herdr, persist });
    } catch (err) {
      log.error("posted handler failed:", err);
      if (post?.channel_id) await say(post.channel_id, post.root_id || post.id, `Error: ${err.message}`);
    }
  }

  async function handleReaction(reaction) {
    try {
      const { user_id: userId, post_id: postId, emoji_name: emoji } = reaction;
      if (userId === botUserId()) return;
      if (!authorized(userId)) return;

      const setup = pendingSetups.get(postId);
      if (setup) {
        const idx = NUMBER_EMOJI.indexOf(emoji);
        const choice = setup.options[idx];
        if (!choice) return;
        state.channels[setup.channelId] = choice.new
          ? { bound: true, machine: setup.machine ?? null }
          : { bound: true, machine: setup.machine ?? null, workspace_id: choice.workspace_id };
        persist();
        pendingSetups.delete(postId);
        for (let i = 0; i < setup.options.length; i++) await mm.removeReaction(postId, NUMBER_EMOJI[i]).catch(() => {});
        await mm.editPost(postId, choice.new
          ? `Channel bound — a new workspace will be created on the first post${setup.machine ? ` on \`${setup.machine}\`` : ""}.`
          : `Channel bound to workspace \`${choice.workspace_id}\`${setup.machine ? ` on \`${setup.machine}\`` : ""}. New root posts spawn agents as tabs there.`).catch(() => {});
        return;
      }

      const mapping = mappingForPrompt(postId);
      if (!mapping) return;
      const plan = { reactions: mapping.prompt_reactions ?? [] };
      const choice = keysForReaction(plan, emoji);
      if (!choice) return;
      const agent = await herdr.getAgent(mapping.agent_name, mapping.machine).catch(() => null);
      const status = agent?.status ?? agent?.agent_status;
      if (status && status !== "blocked") {
        await clearPrompt(mapping, `already answered (agent is ${status})`);
        persist();
        return;
      }
      await herdr.sendKeys(mapping.agent_name, choice.keys, mapping.machine);
      await clearPrompt(mapping, `chose \`${choice.label}\` (${await userName(userId)})`);
      persist();
    } catch (err) {
      log.error("reaction handler failed:", err);
    }
  }

  // ---- polling ------------------------------------------------------------

  async function poll() {
    const byMachine = new Map();
    for (const [rootId, mapping] of Object.entries(state.threads)) {
      const machine = mapping.machine ?? null;
      if (!byMachine.has(machine)) byMachine.set(machine, []);
      byMachine.get(machine).push([rootId, mapping]);
    }
    let dirty = false;
    for (const [machine, entries] of byMachine) {
      const agents = await herdr.listAgents(machine).catch(() => null);
      if (agents === null) continue;
      const byName = new Map();
      for (const a of agents) { const n = a.name ?? a.agent; if (n) byName.set(n, a.status ?? a.agent_status ?? "unknown"); }
      for (const [rootId, mapping] of entries) {
        const status = byName.get(mapping.agent_name);
        dirty = (await relayOutput(rootId, mapping, status)) || dirty;
        dirty = (await relayTransition(rootId, mapping, status)) || dirty;
      }
    }
    if (dirty) persist();
  }

  async function relayOutput(rootId, mapping, status) {
    if (status === undefined) return false;
    const fresh = !relay.has(rootId);
    const text = await herdr.readAgent(mapping.agent_name, { source: "recent-unwrapped", lines: 400, machine: mapping.machine }).catch(() => null);
    if (text === null) return false;
    const emit = relay.update(rootId, text);
    let dirty = false;
    if (fresh) {
      if (mapping.relay_seeded) await say(mapping.channel_id, rootId, "⟳ relay resumed — output since the bot restart is not replayed");
      else { mapping.relay_seeded = true; dirty = true; }
    }
    if (emit.length) await output.append(rootId, { channelId: mapping.channel_id, rootId }, emit.join("\n")).catch((e) => log.error(`relay post failed: ${e.message}`));
    return dirty;
  }

  async function relayTransition(rootId, mapping, status) {
    const prev = mapping.last_status;
    const where = { channelId: mapping.channel_id, rootId };

    if (status === undefined) {
      if (prev === "gone") return false;
      mapping.last_status = "gone";
      const dropped = (mapping.queue ?? []).length;
      mapping.queue = [];
      const rest = relay.flush(rootId);
      relay.drop(rootId);
      if (rest.length) await output.append(rootId, where, rest.join("\n")).catch(() => {});
      output.drop(rootId);
      await clearPrompt(mapping, "agent exited");
      await say(mapping.channel_id, rootId, `Agent \`${mapping.agent_name}\` is no longer running.` + (dropped ? ` ${dropped} held message(s) dropped.` : ""));
      return true;
    }
    if (status === prev) return false;

    mapping.last_status = status;
    const announce = config.statusPosts && prev !== "starting" && prev !== "gone";
    if (prev === "blocked" && mapping.prompt_post_id) await clearPrompt(mapping, "answered");

    if (status === "blocked") {
      output.reset(rootId);
      if (announce) {
        const snapshot = await herdr.readAgent(mapping.agent_name, { source: "detection", lines: 25, machine: mapping.machine }).catch(() => "");
        if (snapshot.trim()) await postOutput(mapping, snapshot);
        const plan = promptPlan(parsePrompt(snapshot), mapping.agent_name);
        const p = await mm.createPost({ channelId: mapping.channel_id, rootId, message: plan.text }).catch(() => null);
        if (p) {
          for (const r of plan.reactions) await mm.addReaction(p.id, r.emoji).catch(() => {});
          mapping.prompt_post_id = p.id;
          mapping.prompt_reactions = plan.reactions;
          mapping.prompt_text = plan.text;
        }
      }
    } else if (status === "done") {
      const rest = relay.flush(rootId);
      if (rest.length) await output.append(rootId, where, rest.join("\n")).catch(() => {});
      output.reset(rootId);
      if (announce) await say(mapping.channel_id, rootId, `✅ \`${mapping.agent_name}\` finished.`);
      await flushQueue(mapping, mm, herdr, persist);
    } else if (status === "idle") {
      await flushQueue(mapping, mm, herdr, persist);
    }
    return true;
  }

  // ---- reconnect catch-up -------------------------------------------------

  async function catchUp() {
    let missed = 0;
    for (const mapping of Object.values(state.threads)) {
      const payload = await mm.threadPosts(mapping.root_id, mapping.last_seen_at ?? 0).catch(() => null);
      if (!payload) continue;
      for (const post of newUserPosts(payload, { since: mapping.last_seen_at ?? 0, botUserId: botUserId() })) {
        missed++;
        await handlePosted(post, null);
      }
    }
    if (missed) log.log(`herdr-mattermost: processed ${missed} message(s) missed while disconnected`);
  }

  function start() {
    connection = mm.connect({ onPosted: handlePosted, onReaction: handleReaction, onConnected: () => catchUp().catch((e) => log.error("catch-up failed:", e)) });
    timer = setInterval(() => poll().catch((e) => log.error("poll failed:", e)), config.pollMs);
  }
  function stop() {
    if (timer) clearInterval(timer);
    connection?.close();
  }

  return { start, stop, handlePosted, handleReaction, poll, catchUp };
}
```

- [ ] **Step 3: Syntax-check and run the existing suite**

Run: `node --check src/bot.js && npm test`
Expected: check passes; all earlier tests still pass.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Add bot orchestration"
```

---

### Task 12: bot.test.js — end-to-end with fakes

**Files:**
- Create: `test/bot.test.js`

**Interfaces:**
- Consumes: `createBot` (Task 11), `OutputWriter` (Task 9), `Relay` (Task 2).

- [ ] **Step 1: Write the tests**

`test/bot.test.js`:
```js
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
  const bot = createBot({ config, mm, herdr, state, saveState() {}, output, relay: new Relay(), team: { id: "team", name: "home" }, allowed, log: { error() {}, log() {} } });
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
```

- [ ] **Step 2: Run the tests**

Run: `node --test test/bot.test.js`
Expected: all pass. If "relayed output" fails on the count, remember the relay only emits a line once it has survived two consecutive reads; the three `poll()` calls above are exactly seed / churn / confirm.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Add end-to-end bot tests with fakes"
```

---

### Task 13: Entrypoints — main.js, run.js, startup.js, actions

**Files:**
- Create: `src/main.js`, `src/run.js`, `src/startup.js`, `src/actions/open-bot.js`, `src/actions/status.js`

**Interfaces:**
- Consumes: `requireConfig`, `config` (Task 3), `MattermostClient` (Task 8), `createBot` (Task 11), `OutputWriter`, `Relay`, `loadState/saveState`, `herdr.js`.
- Produces: the pane entrypoint `node src/run.js` (supervises `main.js`), the startup hook, and the two actions declared in the manifest.

- [ ] **Step 1: Write main.js**

```js
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
```

- [ ] **Step 2: Write run.js (supervisor)**

```js
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
```

- [ ] **Step 3: Write startup.js (autostart hook)**

```js
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
```

- [ ] **Step 4: Write the actions**

`src/actions/open-bot.js`:
```js
import { spawnSync } from "node:child_process";
import { config } from "../config.js";

const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const res = spawnSync(herdr, ["plugin", "pane", "open", "--plugin", config.pluginId, "--entrypoint", "bot", "--placement", "tab"],
  { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] });
process.exit(res.status ?? 1);
```

`src/actions/status.js`:
```js
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
```

- [ ] **Step 5: Syntax-check everything and run the suite**

Run: `for f in src/*.js src/actions/*.js; do node --check $f || exit 1; done && npm test`
Expected: all checks pass; all tests pass. Also run `MM_URL= node src/main.js`; expected: exits 1 with "MM_URL, MM_TOKEN, MM_TEAM not set" (MM_TEAM and token are also unset in a bare env).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Add entrypoints, supervisor, startup hook and actions"
```

---

### Task 14: Server setup script and README

**Files:**
- Create: `scripts/setup-bot.sh`, `README.md`

- [ ] **Step 1: Write scripts/setup-bot.sh**

```bash
#!/usr/bin/env bash
# One-time Mattermost setup for herdr-mattermost. Run on the Mattermost host
# (or anywhere mmctl --local can reach the server's local socket).
#
#   MMCTL="docker exec mattermost mmctl --local" ./scripts/setup-bot.sh home
#
# Creates bot "herdr", generates its access token, adds it to the team, and
# prints the token to put in MM_TOKEN.
set -euo pipefail
TEAM="${1:?usage: setup-bot.sh <team-name>}"
BOT="${BOT_NAME:-herdr}"
MMCTL="${MMCTL:-mmctl --local}"

if ! $MMCTL bot list --json 2>/dev/null | grep -q "\"username\": *\"$BOT\""; then
  $MMCTL bot create "$BOT" --display-name "$BOT" --description "herdr agent bridge" >/dev/null
  echo "created bot @$BOT"
else
  echo "bot @$BOT already exists"
fi
$MMCTL team users add "$TEAM" "$BOT" >/dev/null 2>&1 || true
echo "added @$BOT to team $TEAM"
TOKEN=$($MMCTL token generate "$BOT" "herdr-mattermost $(date +%F)" --json | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' | head -1)
echo
echo "MM_TOKEN=$TOKEN"
echo
echo "Next: invite the bot to each channel you want watched (/invite @$BOT) and put 'herdr:' in the channel header."
```

Then `chmod +x scripts/setup-bot.sh`.

- [ ] **Step 2: Write README.md**

Cover, in this order, each as a short section: what it is (channels = workspaces, root posts = agents, threads = prompts/output; ported from `ralphilius/herdr-discord`, credited); requirements (herdr ≥ 0.9.0, Node ≥ 22, a Mattermost server you admin); Mattermost setup (run `scripts/setup-bot.sh`, invite the bot, channel header `herdr: cwd=~/code/x kind=claude`); install (`herdr plugin install fzf/herdr-mattermost`, or clone + `herdr plugin link .`); configure (`.env` from `.env.example` in `herdr plugin config-dir herdr.mattermost`); run (`herdr plugin action invoke herdr.mattermost.open-bot`, `MM_AUTOSTART=1`); using it (every root post starts an agent; replies prompt; mid-turn behavior table; `!!` passthrough; answering blocked agents by reaction or plain reply); the command tables (channel: `!setup [machine]` `!unbind` `!status` `!help`; thread: `!status` `!read [n]` `!queue` `!approve` `!close` `!help`); how it works (one paragraph per module); security note (anyone who can post in a watched channel can steer agents — use a private channel and `MM_ALLOWED_USERS`); license (MIT for this repo; upstream has no license, used with attribution).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "Add server setup script and README"
```

---

### Task 15: Integration on chat.tacodogs.org

**Files:** none in the repo (config lives in the herdr plugin config dir).

- [ ] **Step 1: Create the bot on the server**

From the Mac:
```bash
ssh -i ~/.config/nanoclaw/agent-keys/homelab -o UserKnownHostsFile=~/.config/nanoclaw/agent-keys/known_hosts fzf@10.0.0.100 \
  'MMCTL="docker exec mattermost mmctl --local" bash -s home' < scripts/setup-bot.sh
```
Expected: prints `MM_TOKEN=…`.

- [ ] **Step 2: Link the plugin and configure it**

```bash
cd ~/Projects/herdr-mattermost && herdr plugin link .
CONFIG_DIR="$(herdr plugin config-dir herdr.mattermost)"
cp .env.example "$CONFIG_DIR/.env"
# edit $CONFIG_DIR/.env: MM_URL=https://chat.tacodogs.org MM_TOKEN=<from step 1> MM_TEAM=home MM_ALLOWED_USERS=fzf MM_AUTOSTART=1
chmod 600 "$CONFIG_DIR/.env"
herdr plugin action invoke herdr.mattermost.status
```
Expected: status prints server, team and "token: configured".

- [ ] **Step 3: Open the bot pane and verify login**

```bash
herdr plugin action invoke herdr.mattermost.open-bot
herdr plugin log list --plugin herdr.mattermost | tail -5
```
Expected: the pane logs `logged in as @herdr on https://chat.tacodogs.org (team home)`.

- [ ] **Step 4: Manual end-to-end in Mattermost**

In the `home` team create a private channel `agents`, `/invite @herdr`, set the header to `herdr: kind=claude cwd=~/Projects/herdr-mattermost`. Then:
1. Post `say hello and list the files in this directory` as a root post → expect "Starting a claude agent…" then "Agent `mm-say-hello-…` is up", a new tab in herdr, and output appearing in the thread as one growing fenced post.
2. When the agent blocks on a permission prompt → expect the snapshot post, then the prompt post with number reactions; tap a reaction → keys are sent and the post is edited with the choice.
3. Reply `now summarize what you did` → expect ✅ reaction and the agent continuing; `!status`; `!read 20`; `!close`.
4. Kill the bot pane and reopen it; reply in a thread while the bot was down, then reopen → expect the reply to be processed by catch-up.
Record anything that misbehaves as follow-up fixes in the same branch, with tests where the logic is testable.

- [ ] **Step 5: Turn off the Discord plugin**

Only after step 4 passes: `herdr plugin uninstall herdr.discord` (config and state are preserved by herdr, so this is reversible).

---

### Task 16: Publish

- [ ] **Step 1: Create the GitHub repo and push**

```bash
cd ~/Projects/herdr-mattermost
gh repo create fzf/herdr-mattermost --public --source=. --push --description "Herdr plugin: Mattermost as a UI layer. Channels are workspaces, root posts are agents."
gh repo edit fzf/herdr-mattermost --add-topic herdr-plugin --add-topic herdr --add-topic mattermost
```

- [ ] **Step 2: Tag the release**

```bash
npm version 0.1.0 --allow-same-version -m "Release %s" && git push && git push --tags
```
Expected: `herdr-plugin.toml` version matches, tag `v0.1.0` pushed, marketplace lists the plugin within ~30 minutes.

- [ ] **Step 3: Switch the installed plugin from the local link to the GitHub install**

```bash
herdr plugin unlink herdr.mattermost && herdr plugin install fzf/herdr-mattermost --yes
```
The config dir is keyed by plugin id, so `.env` carries over. Reopen the bot pane and confirm it logs in.
