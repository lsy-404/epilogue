import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
const packages = [
  ["@model-auth/core", "0.3.0", "vendor/model-auth/core-0.3.0.tgz"],
  ["@model-auth/providers", "0.3.0", "vendor/model-auth/providers-0.3.0.tgz"],
  ["@model-auth/vue", "0.4.1", "vendor/model-auth/vue-0.4.1.tgz"],
];

for (const [name, version, relativePath] of packages) {
  const dependency = `file:${relativePath}`;
  assert.equal(manifest.dependencies[name], dependency);

  const lockKey = `  '${name}@${dependency}':`;
  const lockStart = lock.indexOf(lockKey);
  assert.notEqual(lockStart, -1, `${name} must be represented in pnpm-lock.yaml`);
  const nextLockEntry = lock.indexOf("\n  '", lockStart + lockKey.length);
  const lockEntry = lock.slice(lockStart, nextLockEntry === -1 ? undefined : nextLockEntry);

  const archive = path.join(root, relativePath);
  const bytes = await readFile(archive);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  assert.ok(lockEntry.includes(`integrity: ${integrity}, tarball: ${dependency}`));
  assert.ok(lockEntry.includes(`version: ${version}`));

  const { stdout: packageJson } = await execFileAsync("tar", ["-xOf", archive, "package/package.json"]);
  const archivedManifest = JSON.parse(packageJson);
  assert.equal(archivedManifest.name, name);
  assert.equal(archivedManifest.version, version);
  await execFileAsync("tar", ["-tzf", archive, "package/LICENSE"]);
}

const workflow = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");
assert.match(workflow, /pnpm install --frozen-lockfile/);
assert.doesNotMatch(releaseWorkflow, /secrets\.PLATFORM_KIT_TOKEN/);
assert.doesNotMatch(lock, /file:\.platform-kit-private/);
assert.doesNotMatch(lock, /https:\/\/github\.com\/lsy-404\/platform-kit\/releases\/download\/v0\.6\.1/);
console.log("Public model-auth release dependency contract passed.");
