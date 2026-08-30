'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { writeChecksum } = require('../scripts/checksum');

async function makeOnnxFixture(root) {
  const runtimes = {
    darwin: { arm64: 'libonnxruntime.1.0.dylib', x64: 'libonnxruntime.1.0.dylib' },
    linux: { arm64: 'libonnxruntime.so.1', x64: 'libonnxruntime.so.1' },
    win32: { arm64: 'onnxruntime.dll', x64: 'onnxruntime.dll' },
  };
  const ortRoot = path.join(root, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  for (const [platform, arches] of Object.entries(runtimes)) {
    for (const [arch, runtime] of Object.entries(arches)) {
      const target = path.join(ortRoot, platform, arch);
      await fs.promises.mkdir(target, { recursive: true });
      await fs.promises.writeFile(path.join(target, 'onnxruntime_binding.node'), 'binding');
      await fs.promises.writeFile(path.join(target, runtime), 'runtime');
    }
  }
  await fs.promises.writeFile(
    path.join(ortRoot, 'linux', 'x64', 'libonnxruntime_providers_cuda.so'),
    'unused',
  );
  return ortRoot;
}

test('ONNX pruning keeps exactly the requested runtime pair', async (t) => {
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'epilogue-pack-'));
  t.after(() => fs.promises.rm(fixture, { recursive: true, force: true }));
  const ortRoot = await makeOnnxFixture(fixture);
  const { pruneOnnxRuntime } = await import('../scripts/package-app.mjs');

  const result = await pruneOnnxRuntime(fixture, 'linux', 'x64');

  assert.deepEqual(result.removedPairs, [
    'darwin/arm64',
    'darwin/x64',
    'linux/arm64',
    'win32/arm64',
    'win32/x64',
  ]);
  assert.equal(result.removedProviders, 1);
  assert.deepEqual(await fs.promises.readdir(ortRoot), ['linux']);
  assert.deepEqual(await fs.promises.readdir(path.join(ortRoot, 'linux')), ['x64']);
  assert.equal(
    fs.existsSync(path.join(ortRoot, 'linux', 'x64', 'onnxruntime_binding.node')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(ortRoot, 'linux', 'x64', 'libonnxruntime_providers_cuda.so')),
    false,
  );
});

test('ONNX pruning fails before deletion if the requested runtime is missing', async (t) => {
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'epilogue-pack-'));
  t.after(() => fs.promises.rm(fixture, { recursive: true, force: true }));
  const ortRoot = await makeOnnxFixture(fixture);
  const { pruneOnnxRuntime } = await import('../scripts/package-app.mjs');

  await fs.promises.rm(path.join(ortRoot, 'darwin', 'arm64'), { recursive: true });
  await assert.rejects(
    () => pruneOnnxRuntime(fixture, 'darwin', 'arm64'),
    /does not contain darwin\/arm64/,
  );
  assert.equal(fs.existsSync(path.join(ortRoot, 'linux', 'x64')), true);
});

test('ASAR verification requires native addons and sibling libraries to be unpacked', async (t) => {
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'epilogue-asar-'));
  t.after(() => fs.promises.rm(fixture, { recursive: true, force: true }));
  const appRoot = path.join(fixture, 'app');
  const runtime = path.join(
    appRoot,
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
    'win32',
    'x64',
  );
  await fs.promises.mkdir(runtime, { recursive: true });
  await fs.promises.writeFile(path.join(runtime, 'onnxruntime_binding.node'), 'binding');
  await fs.promises.writeFile(path.join(runtime, 'onnxruntime.dll'), 'runtime');

  const asarPath = path.join(fixture, 'app.asar');
  const { createPackageWithOptions } = await import('@electron/asar');
  const { NATIVE_BINARY_GLOB, verifyAsarOnnxRuntime } = await import('../scripts/package-app.mjs');
  await createPackageWithOptions(appRoot, asarPath, { unpack: NATIVE_BINARY_GLOB });

  const result = verifyAsarOnnxRuntime(asarPath, 'win32', 'x64');
  assert.equal(result.nativeFileCount, 2);
  assert.equal(
    fs.existsSync(
      `${asarPath}.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll`,
    ),
    true,
  );
});

test('checksum writer emits a portable SHA-256 sidecar', async (t) => {
  const fixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'epilogue-sum-'));
  t.after(() => fs.promises.rm(fixture, { recursive: true, force: true }));
  const asset = path.join(fixture, 'Epilogue-test.exe');
  await fs.promises.writeFile(asset, 'epilogue');

  const { checksumPath, digest } = await writeChecksum(asset);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(
    await fs.promises.readFile(checksumPath, 'utf8'),
    `${digest} *Epilogue-test.exe\n`,
  );
});

test('release workflow pins supply-chain actions and installer tools', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8',
  );

  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40} # v7\.0\.1/);
  assert.match(workflow, /actions\/setup-node@[a-f0-9]{40} # v7\.0\.0/);
  assert.match(workflow, /actions\/attest@[a-f0-9]{40} # v4\.2\.2/);
  assert.match(workflow, /softprops\/action-gh-release@[a-f0-9]{40} # v3\.0\.2/);
  assert.match(workflow, /electron-winstaller@5\.4\.4/);
  assert.match(workflow, /electron-installer-debian@4\.0\.0/);
  assert.doesNotMatch(workflow, /macos-15-intel/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
});
