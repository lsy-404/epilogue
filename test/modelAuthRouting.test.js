'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeCandidates } = require('../src/main/llm');

test('weighted routing chooses an independent credential before its siblings', () => {
  const credentials = [
    { id: 'a', modelAuthProviderId: 'provider', routeStrategy: 'weighted-round-robin', weight: 1, enabled: true, baseUrl: 'https://a.test', apiKey: 'a' },
    { id: 'b', modelAuthProviderId: 'provider', routeStrategy: 'weighted-round-robin', weight: 3, enabled: true, baseUrl: 'https://b.test', apiKey: 'b' },
  ];
  const first = routeCandidates(credentials);
  const second = routeCandidates(credentials);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.notEqual(first[0].id, second[0].id);
  assert.equal(first[0].id, first[1].id === 'a' ? 'b' : 'a');
});

test('failover retains the configured credential order', () => {
  const list = routeCandidates([
    { id: 'one', modelAuthProviderId: 'provider', routeStrategy: 'failover', enabled: true, baseUrl: 'https://one.test', apiKey: 'one' },
    { id: 'two', modelAuthProviderId: 'provider', routeStrategy: 'failover', enabled: true, baseUrl: 'https://two.test', apiKey: 'two' },
  ]);
  assert.deepEqual(list.map((provider) => provider.id), ['one', 'two']);
});
