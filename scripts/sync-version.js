import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const path = "herdr-plugin.toml";
const toml = readFileSync(path, "utf8").replace(/^version = ".*"$/m, `version = "${pkg.version}"`);
writeFileSync(path, toml);
console.log(`herdr-plugin.toml version -> ${pkg.version}`);
