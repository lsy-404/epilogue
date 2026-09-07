import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = await readFile(path.join(root, "package-lock.json"), "utf8");
const release = "https://github.com/lsy-404/platform-kit/releases/download/v0.1.0";
for (const name of ["core", "providers", "vue"]) {
  assert.equal(manifest.dependencies[`@model-auth/${name}`], `${release}/model-auth-${name}-0.2.7.tgz`);
  assert.match(lock, new RegExp(`${release.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/model-auth-${name}-0\\.2\\.7\\.tgz`));
}
const workflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
assert.match(workflow, /npm ci --no-audit --no-fund/);
assert.doesNotMatch(workflow, /secrets\.PLATFORM_KIT_TOKEN/);
assert.doesNotMatch(lock, /file:\.platform-kit-private/);
console.log("Public model-auth release dependency contract passed.");
