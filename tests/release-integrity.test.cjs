const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const contentScript = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");

test("public version declarations stay aligned", () => {
  assert.equal(packageJson.version, manifest.version);
  assert.ok(readme.includes("当前版本：`" + manifest.version + "`"));
});

test("the chat panel reads its version from the manifest", () => {
  assert.match(contentScript, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.doesNotMatch(contentScript, />v\d+\.\d+\.\d+</);
});
