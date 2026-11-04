'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createVerifier, getProductionVerifier } = require('../src/main/proVerify');
const { makeKeys, signLicense, b64u } = require('./helpers/pro');

const keys = makeKeys();
const verifier = createVerifier(keys.verifierKeys);
const reject = (text, code) =>
  assert.throws(() => verifier.verifyLicense(text), (error) => error.code === code, `expected ${code}`);

test('a correctly signed license is accepted and exposes its payload', () => {
  const payload = verifier.verifyLicense(signLicense(keys.license, { name: 'Ada', upd: '2027-06-30' }));
  assert.equal(payload.name, 'Ada');
  assert.equal(payload.upd, '2027-06-30');
  assert.equal(payload.sku, 'pro');
  assert.equal(Object.isFrozen(payload), true);
});

test('malformed licenses are rejected', () => {
  const good = signLicense(keys.license);
  const [, payloadB64, sigB64] = good.split('.');
  reject(`EPRO2.${payloadB64}.${sigB64}`, 'license_format');
  reject(`EPRO1.${payloadB64}`, 'license_format');
  reject(`EPRO1.${payloadB64}.${sigB64}.extra`, 'license_format');
  reject(`EPRO1.!!!.${sigB64}`, 'license_format');
  reject(`EPRO1.${payloadB64}.@@@`, 'license_format');
  reject(`EPRO1.${b64u('not json')}.${sigB64}`, 'license_format');
});

test('unknown kid and forged signatures are rejected', () => {
  const other = makeKeys();
  reject(signLicense({ ...other.license, kid: 'lic-unknown' }), 'license_kid');
  reject(signLicense({ ...other.license, kid: keys.license.kid }), 'license_signature');
  const [prefix, payloadB64, sigB64] = signLicense(keys.license).split('.');
  const tampered = b64u(JSON.stringify({ ...JSON.parse(Buffer.from(payloadB64, 'base64url')), upd: '2099-01-01' }));
  reject(`${prefix}.${tampered}.${sigB64}`, 'license_signature');
});

test('wrong version, sku and malformed dates are rejected', () => {
  reject(signLicense(keys.license, { v: 2 }), 'license_version');
  reject(signLicense(keys.license, { sku: 'team' }), 'license_sku');
  reject(signLicense(keys.license, { upd: '2027-13-01' }), 'license_dates');
  reject(signLicense(keys.license, { iat: '2026/12/01' }), 'license_dates');
  reject(signLicense(keys.license, { upd: '2027-02-30' }), 'license_dates');
  reject(signLicense(keys.license, { exp: 'soon' }), 'license_dates');
});

test('exp is only enforced when present', () => {
  const text = signLicense(keys.license, { exp: '2027-01-01' });
  assert.doesNotThrow(() => verifier.verifyLicense(text, { now: new Date('2027-01-01T12:00:00Z') }));
  assert.throws(() => verifier.verifyLicense(text, { now: new Date('2027-01-02T00:00:00Z') }), (e) => e.code === 'license_expired');
  assert.doesNotThrow(() => verifier.verifyLicense(signLicense(keys.license), { now: new Date('2099-01-01') }));
});

test('feature date coverage includes the update date itself', () => {
  const license = verifier.verifyLicense(signLicense(keys.license, { upd: '2027-12-01' }));
  const manifest = (featureDate) => ({ api: 1, platform: process.platform, arch: process.arch, featureDate });
  assert.doesNotThrow(() => verifier.checkCompatibility(manifest('2027-12-01'), license));
  assert.doesNotThrow(() => verifier.checkCompatibility(manifest('2027-11-30'), license));
  assert.throws(() => verifier.checkCompatibility(manifest('2027-12-02'), license), (e) => e.code === 'package_feature_date');
});

test('the production verifier trusts only its fixed kids and rejects test-key licenses', () => {
  const production = getProductionVerifier();
  const table = require('../src/main/proKeys');
  assert.deepEqual(Object.keys(table.extensionKeys), ['ext-2026a']);
  assert.deepEqual(Object.keys(table.licenseKeys), ['lic-2026a']);
  assert.throws(() => production.verifyLicense(signLicense(keys.license)), (e) => e.code === 'license_kid');
  const forged = signLicense({ ...keys.license, kid: 'lic-2026a' });
  assert.throws(() => production.verifyLicense(forged), (e) => e.code === 'license_signature');
});
