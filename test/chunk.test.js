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
