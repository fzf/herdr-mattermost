import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("manifest and package versions match", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const toml = readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
  assert.match(toml, new RegExp(`^version = "${pkg.version.replace(/\./g, "\\.")}"$`, "m"));
  assert.match(toml, /^id = "herdr\.mattermost"$/m);
});
