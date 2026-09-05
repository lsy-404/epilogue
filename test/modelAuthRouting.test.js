'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
test('shared CredentialRouter applies credential health without raw stdout fallbacks', async () => {
  const { CredentialRouter, createCredentialMetadata } = await import('@model-auth/core');
  const router = new CredentialRouter([
    createCredentialMetadata({ id: 'first', providerId: 'catalog-openai', authMethod: 'api-key', weight: 1, modelIds: ['model-1'] }),
    createCredentialMetadata({ id: 'second', providerId: 'catalog-openai', authMethod: 'api-key', weight: 2, modelIds: ['model-1'] }),
  ], { transientCooldownMs: 1 });
  router.reportError('first', { kind: 'http', status: 429 });
  assert.equal(router.health('first').health, 'cooling-down');
  assert.deepEqual(router.candidates({ providerId: 'catalog-openai', modelId: 'model-1' }).map((credential) => credential.id), ['second']);
  router.reportError('second', { kind: 'http', status: 401 });
  assert.equal(router.health('second').health, 'permanently-failed');
});
