'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const trae = require('../src/main/trae');

test('TRAE account-default leaves model selection to the authenticated CLI session', () => {
  const request = trae.executionRequest({ model: 'trae-account-default' }, [{ role: 'user', content: 'Ping' }]);
  assert.equal('model' in request, false);
});

test('TRAE forwards only an explicit non-default model and structured tools', () => {
  const request = trae.executionRequest({ model: 'enterprise-model', traeCwd: '/tmp' }, [{ role: 'user', content: 'Ping' }], {
    tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: {} } }],
  });
  assert.equal(request.model, 'enterprise-model');
  assert.equal(request.tools[0].inputSchema.type, 'object');
});
