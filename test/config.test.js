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
