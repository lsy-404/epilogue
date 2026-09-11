import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = await readFile(path.join(root, "package-lock.json"), "utf8");
const publicKitVersion = "0.5.3";
const release = `https://github.com/lsy-404/platform-kit/releases/download/v${publicKitVersion}`;
for (const name of ["core", "providers"]) {
  const expected = `${release}/model-auth-${name}-${publicKitVersion}.tgz`;
  assert.equal(manifest.dependencies[`@model-auth/${name}`], expected);
  assert.ok(lock.includes(expected));
}
const vueRelease = `${release}/model-auth-vue-${publicKitVersion}.tgz`;
assert.equal(manifest.dependencies["@model-auth/vue"], vueRelease);
assert.ok(lock.includes(vueRelease));
const workflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
assert.match(workflow, /npm ci --no-audit --no-fund/);
assert.doesNotMatch(workflow, /secrets\.PLATFORM_KIT_TOKEN/);
assert.doesNotMatch(lock, /file:\.platform-kit-private/);
console.log("Public model-auth release dependency contract passed.");
