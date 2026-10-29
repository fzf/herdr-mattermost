import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

process.env.HERDR_BIN_PATH = fileURLToPath(new URL("./fixtures/fake-herdr.sh", import.meta.url));
const { herdr } = await import("../src/herdr.js");

test("a JSON error printed on stderr with a non-zero exit surfaces its real code", async () => {
  await assert.rejects(() => herdr(["stderr-json"]), (e) => e.code === "agent_not_ready" && /blocked during startup/.test(e.message));
});

test("a JSON error on stdout keeps its code; plain failures are exit_error; success resolves the result", async () => {
  await assert.rejects(() => herdr(["stdout-json-error"]), (e) => e.code === "agent_blocked");
  await assert.rejects(() => herdr(["plain"]), (e) => e.code === "exit_error" && /plain failure/.test(e.message));
  assert.deepEqual(await herdr(["ok"]), { agent: { name: "a" } });
});
