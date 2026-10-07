import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
const legacyVendor = path.join(root, "vendor", "model-auth");
assert.equal((await readdir(legacyVendor).catch(() => [])).length, 0);
for (const [name, version] of [["core", "0.9.0"], ["providers", "0.13.0"], ["vue", "0.10.3"]]) {
  const dependency = `https://github.com/lsy-404/platform-kit/releases/download/model-auth-${name}-v${version}/model-auth-${name}-${version}.tgz`;
  assert.equal(manifest.dependencies[`@model-auth/${name}`], dependency);
  const lockKey = `  '@model-auth/${name}@${dependency}':`;
  const lockStart = lock.indexOf(lockKey);
  assert.notEqual(lockStart, -1);
  const nextEntry = lock.indexOf("\n  '", lockStart + lockKey.length);
  const lockEntry = lock.slice(lockStart, nextEntry === -1 ? undefined : nextEntry);
  assert.match(lockEntry, /integrity: sha512-[A-Za-z0-9+/]+=*/);
  assert.ok(lockEntry.includes(`version: ${version}`));
  const installed = path.join(root, `node_modules/@model-auth/${name}`);
  const actual = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(actual.name, `@model-auth/${name}`);
  assert.equal(actual.version, version);
  assert.ok((await readFile(path.join(installed, "LICENSE"), "utf8")).includes("Apache License"));
}
await import("@model-auth/core");
await import("@model-auth/providers/usage");
const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
assert.match(workflow, /pnpm install --frozen-lockfile/);
assert.doesNotMatch(releaseWorkflow, /secrets\.PLATFORM_KIT_TOKEN/);
assert.doesNotMatch(lock, /file:\.platform-kit-private/);
console.log("Public model-auth release dependency contract passed.");
