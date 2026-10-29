import test from "node:test";
import assert from "node:assert/strict";
import { parsePrompt, keysForOption } from "../src/prompts.js";

test("numbered menu with a cursor row parses as options", () => {
  const p = parsePrompt("Proceed?\n❯ 1. Yes\n  2. No");
  assert.equal(p.type, "options");
  assert.equal(p.options.length, 2);
  assert.equal(p.cursor, 0);
});

test("cursor-only menu (Claude Code trust dialog) parses as options with the cursor row", () => {
  const snap = [
    " Accessing workspace:",
    "",
    " /Users/fzf/Projects/x",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");
  const p = parsePrompt(snap);
  assert.equal(p.type, "options");
  assert.deepEqual(p.options.map((o) => o.label), ["No, exit", "Yes, I trust this folder"]);
  assert.equal(p.cursor, 0);
  assert.deepEqual(keysForOption(p, 1), ["down", "enter"]);
  assert.deepEqual(keysForOption(p, 0), ["enter"]);
});

test("a lone cursor line is not a menu", () => {
  assert.equal(parsePrompt("❯ just a prompt").type, "unknown");
});
