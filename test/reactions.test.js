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
