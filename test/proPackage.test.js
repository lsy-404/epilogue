'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVerifier, getProductionVerifier } = require('../src/main/proVerify');
const { createExtensionManager } = require('../src/main/extensions');
const { makeKeys, signLicense, buildParts, zipParts, buildPackage } = require('./helpers/pro');

const keys = makeKeys();
const verifier = createVerifier(keys.verifierKeys);

function setup({ upd = '2027-12-01', verifierOverride = verifier } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'epilogue-pro-'));
  const handlers = new Map();
  const manager = createExtensionManager({
    verifier: verifierOverride,
    userData,
    coreVersion: '0.0.0-test',
    settings: { get: () => ({}), patch: (p) => p },
    ipcHandle: (channel, fn) => handlers.set(channel, fn),
    ipcRemove: (channel) => handlers.delete(channel),
  });
  if (upd) manager.importLicense(signLicense(keys.license, { upd }));
  return { userData, manager, handlers, ext: path.join(userData, 'pro', 'ext') };
}

const rejects = (manager, zip, code) =>
  assert.throws(() => manager.installPackage(zip), (error) => error.code === code, `expected ${code}`);

test('a valid package installs, becomes current, and activates', async () => {
  const { manager, handlers, ext, userData } = setup();
  const status = manager.installPackage(buildPackage(keys.extension));
  assert.equal(status.package.version, '1.0.0');
  assert.equal(status.package.covered, true);
  const pointer = JSON.parse(fs.readFileSync(path.join(userData, 'pro', 'current.json'), 'utf8'));
  assert.deepEqual(pointer, { version: '1.0.0', previous: null });
  assert.deepEqual(fs.readdirSync(ext), ['1.0.0']);
  const loaded = await manager.load();
  assert.equal(loaded.active, true);
  assert.equal(await handlers.get('pro:ping')({}), 'pong');
  assert.equal(manager.rendererSource().toString(), 'window.__proTest = true;');
});

test('upgrading keeps the previous version, prunes older ones, and cleans staging', () => {
  const { manager, ext, userData } = setup();
  for (const version of ['1.0.0', '1.1.0', '1.2.0']) manager.installPackage(buildPackage(keys.extension, { version }));
  assert.deepEqual(fs.readdirSync(ext).sort(), ['1.1.0', '1.2.0']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'pro', 'current.json'), 'utf8')), {
    version: '1.2.0',
    previous: '1.1.0',
  });
  assert.equal(manager.rollback().package.version, '1.1.0');
});

test('a rejected package leaves the installed version and no staging directory', () => {
  const { manager, ext } = setup();
  manager.installPackage(buildPackage(keys.extension));
  rejects(manager, buildPackage(keys.extension, { version: '2.0.0', featureDate: '2030-01-01' }), 'package_feature_date');
  assert.deepEqual(fs.readdirSync(ext), ['1.0.0']);
  assert.equal(manager.status().package.version, '1.0.0');
});

test('tampered content, manifest and signature are rejected', () => {
  const { manager } = setup();
  const parts = buildParts(keys.extension);
  const fileTamper = { ...parts, files: { ...parts.files, 'main.cjs': Buffer.from('x'.repeat(parts.files['main.cjs'].length)) } };
  rejects(manager, zipParts(fileTamper), 'package_hash');
  const manifestTamper = { ...parts, manifestBytes: Buffer.from(parts.manifestBytes.toString().replace('1.0.0', '9.9.9')) };
  rejects(manager, zipParts(manifestTamper), 'package_signature');
  const wrongKey = makeKeys();
  rejects(manager, buildPackage(wrongKey.extension, { kid: keys.extension.kid }), 'package_signature');
});

test('unknown kid is rejected', () => {
  const { manager } = setup();
  rejects(manager, buildPackage(keys.extension, { kid: 'ext-unknown' }), 'package_kid');
});

test('api, platform and arch mismatches are rejected', () => {
  const { manager } = setup();
  rejects(manager, buildPackage(keys.extension, { api: 2 }), 'package_api');
  rejects(manager, buildPackage(keys.extension, { manifest: { platform: 'nonexistent-os' } }), 'package_platform');
  rejects(manager, buildPackage(keys.extension, { manifest: { arch: 'nonexistent-arch' } }), 'package_platform');
});

test('feature date outside the license is rejected and a missing license blocks install', () => {
  const { manager } = setup({ upd: '2027-01-01' });
  rejects(manager, buildPackage(keys.extension, { featureDate: '2027-01-02' }), 'package_feature_date');
  assert.doesNotThrow(() => manager.installPackage(buildPackage(keys.extension, { featureDate: '2027-01-01' })));
  const none = setup({ upd: null });
  rejects(none.manager, buildPackage(keys.extension), 'license_required');
});

test('unsafe zip entries are rejected', () => {
  const { manager } = setup();
  const parts = buildParts(keys.extension);
  const withEntry = (name, mutate) =>
    zipParts(parts, (zip) => {
      zip.addFile('placeholder', Buffer.from('x'));
      const entry = zip.getEntries().find((e) => e.entryName === 'placeholder');
      entry.entryName = name;
      mutate?.(entry);
    });
  rejects(manager, withEntry('../evil.txt'), 'package_path');
  rejects(manager, withEntry('/abs.txt'), 'package_path');
  rejects(manager, withEntry('C:/abs.txt'), 'package_path');
  rejects(manager, withEntry('sub/evil.txt'), 'package_path');
  rejects(
    manager,
    withEntry('link', (entry) => {
      entry.header.attr = (0o120777 << 16) >>> 0;
    }),
    'package_path'
  );
  rejects(manager, withEntry('extra.bin'), 'package_unlisted');
});

test('oversize files are rejected', () => {
  const { manager } = setup();
  const big = Buffer.alloc(33 * 1024 * 1024);
  rejects(manager, buildPackage(keys.extension, { files: { 'main.cjs': big, 'renderer.js': Buffer.from('x') } }), 'package_size');
});

test('a package modified on disk after install is not loaded', async () => {
  const { manager, ext } = setup();
  manager.installPackage(buildPackage(keys.extension));
  const file = path.join(ext, '1.0.0', 'main.cjs');
  fs.writeFileSync(file, 'x'.repeat(fs.statSync(file).size));
  const status = await manager.load();
  assert.equal(status.active, false);
  assert.equal(status.loadError, 'package_hash');
});

test('extension code only gets node built-ins', async () => {
  const { manager } = setup();
  manager.installPackage(
    buildPackage(keys.extension, {
      files: {
        'main.cjs': Buffer.from('require("node:path"); require("electron"); exports.activate = () => {};'),
        'renderer.js': Buffer.from(''),
      },
    })
  );
  const status = await manager.load();
  assert.equal(status.active, false);
  assert.equal(status.loadError, 'activate_failed');
});

test('production verifier rejects packages and licenses signed with other keys', () => {
  const { manager } = setup({ upd: null, verifierOverride: getProductionVerifier() });
  rejects(manager, buildPackage(keys.extension), 'license_required');
  assert.throws(() => manager.importLicense(signLicense(keys.license)), (e) => e.code === 'license_kid');
  assert.throws(() => getProductionVerifier().readZip(buildPackage(keys.extension)), (e) => e.code === 'package_kid');
  const forged = buildPackage({ ...keys.extension, kid: 'ext-2026a' });
  assert.throws(() => getProductionVerifier().readZip(forged), (e) => e.code === 'package_signature');
});
