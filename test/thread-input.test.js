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
