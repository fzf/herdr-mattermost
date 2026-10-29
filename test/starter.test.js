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
