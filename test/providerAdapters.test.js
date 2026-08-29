'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../src/main/providerAdapters');
const { migrate } = require('../src/main/settings');

test('v4 settings migration preserves configured legacy providers on Chat Completions', () => {
  const migrated = migrate({
    version: 2,
    providers: { chat: [{ name: 'Legacy', baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'x' }] },
  });
  assert.equal(migrated.version, 4);
  assert.equal(migrated.providers.chat[0].protocol, 'openai-completions');
});

test('v4 migration removes only unconfigured legacy free defaults', () => {
  const migrated = migrate({
    version: 3,
    providers: { chat: [
      { name: 'Pollinations 内置免费', baseUrl: 'https://text.pollinations.ai/openai', keyless: true, model: 'openai' },
      { name: 'OpenRouter Free', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'free' },
      { name: 'OpenCode Zen Free', baseUrl: 'https://opencode.ai/zen/v1', apiKey: '', model: 'free' },
      { name: 'OpenRouter Free', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'user-key', model: 'chosen' },
      { name: 'My OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'chosen' },
    ] },
  });
  assert.deepEqual(migrated.providers.chat.map((provider) => provider.name), ['OpenRouter Free', 'My OpenRouter']);
  assert.equal(migrated.providers.chat[0].apiKey, 'user-key');
});

test('OpenAI Chat adapter builds native tools and parses calls', () => {
  const provider = {
    protocol: 'openai-completions',
    baseUrl: 'https://example.test/v1/',
    apiKey: 'secret',
    model: 'chat-model',
  };
  const body = adapters.buildChatRequest(provider, [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Find a file.' },
  ], {
    temperature: 0.2,
    tools: [{ name: 'search_files', description: 'Search', parameters: { type: 'object' } }],
  });
  assert.equal(adapters.endpointFor(provider), 'https://example.test/v1/chat/completions');
  assert.equal(adapters.requestHeaders(provider).Authorization, 'Bearer secret');
  assert.equal(body.tools[0].function.name, 'search_files');

  const result = adapters.parseChatResponse(provider, {
    choices: [{
      message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_files', arguments: '{"query":"report"}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  });
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'search_files', arguments: { query: 'report' } }]);
  assert.equal(result.usage.totalTokens, 13);
});

test('OpenAI Responses adapter preserves tool round-trips', () => {
  const provider = { protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'secret', model: 'gpt-test' };
  const body = adapters.buildChatRequest(provider, [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Look up x' },
    { role: 'assistant', content: 'Checking', toolCalls: [{ id: 'call_a', name: 'lookup', arguments: { q: 'x' } }] },
    { role: 'tool', toolCallId: 'call_a', name: 'lookup', content: '{"ok":true}' },
  ], {});
  assert.equal(adapters.endpointFor(provider), 'https://api.openai.com/v1/responses');
  assert.equal(body.instructions, 'System');
  assert.deepEqual(body.input, [
    { role: 'user', content: 'Look up x' },
    { role: 'assistant', content: 'Checking' },
    { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: '{"q":"x"}' },
    { type: 'function_call_output', call_id: 'call_a', output: '{"ok":true}' },
  ]);

  const result = adapters.parseChatResponse(provider, {
    output_text: 'Done',
    output: [{ type: 'function_call', call_id: 'call_b', name: 'lookup', arguments: '{"q":"y"}' }],
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  assert.equal(result.text, 'Done');
  assert.equal(result.toolCalls[0].id, 'call_b');
  assert.equal(result.usage.totalTokens, 7);
});

test('Anthropic Messages adapter applies native authentication and content blocks', () => {
  const provider = { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'secret', model: 'claude-test' };
  const headers = adapters.requestHeaders(provider, { 'Content-Type': 'application/json' });
  assert.equal(headers['x-api-key'], 'secret');
  assert.equal(headers['anthropic-version'], '2023-06-01');

  const body = adapters.buildChatRequest(provider, [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Hello' },
  ], { tools: [{ name: 'get_status', parameters: { type: 'object', properties: {} } }] });
  assert.equal(adapters.endpointFor(provider), 'https://api.anthropic.com/v1/messages');
  assert.equal(body.system, 'System');
  assert.equal(body.tools[0].input_schema.type, 'object');

  const result = adapters.parseChatResponse(provider, {
    content: [
      { type: 'text', text: 'I will check.' },
      { type: 'tool_use', id: 'tool_1', name: 'get_status', input: {} },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 9, output_tokens: 4 },
  });
  assert.equal(result.text, 'I will check.');
  assert.deepEqual(result.toolCalls[0], { id: 'tool_1', name: 'get_status', arguments: {} });
});

test('Anthropic Messages adapter groups parallel tool results into one user turn', () => {
  const provider = { protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test' };
  const body = adapters.buildChatRequest(provider, [
    { role: 'user', content: 'Check both.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tool_1', name: 'search_files', arguments: { query: 'a' } },
        { id: 'tool_2', name: 'get_status', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'tool_1', content: '{"hits":[]}' },
    { role: 'tool', toolCallId: 'tool_2', content: '{"ok":true}' },
  ]);
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[2].role, 'user');
  assert.deepEqual(body.messages[2].content.map((item) => item.tool_use_id), ['tool_1', 'tool_2']);
});

test('provider overlays cannot replace managed request state', () => {
  const provider = {
    protocol: 'openai-completions', baseUrl: 'https://example.test/v1', model: 'x',
    body: { messages: [{ role: 'user', content: 'spoofed' }] },
  };
  assert.throws(
    () => adapters.buildChatRequest(provider, [{ role: 'user', content: 'real' }]),
    /cannot override managed request field/,
  );
});

test('Compatible adapter supports nested request overlays and manual response paths', () => {
  const provider = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'compatible-model',
    body: { metadata: { tenant: 'iris' }, vendor: { mode: 'fast' } },
    responseMode: 'manual',
    response: {
      textPath: 'result.content[0].text',
      toolCallsPath: 'result.calls',
      inputTokensPath: 'metrics.tokens.in',
      outputTokensPath: 'metrics.tokens.out',
      stopReasonPath: 'result.reason',
      errorPath: 'failure.message',
    },
  };
  const body = adapters.buildChatRequest(provider, [{ role: 'user', content: 'Hello' }]);
  assert.deepEqual(body.metadata, { tenant: 'iris' });
  assert.deepEqual(body.vendor, { mode: 'fast' });

  const parsed = adapters.parseChatResponse(provider, {
    result: {
      content: [{ text: 'Mapped response' }],
      calls: [{ id: 'mapped_1', name: 'get_status', arguments: { verbose: true } }],
      reason: 'tool_calls',
    },
    metrics: { tokens: { in: 7, out: 5 } },
  });
  assert.equal(parsed.text, 'Mapped response');
  assert.deepEqual(parsed.toolCalls, [{ id: 'mapped_1', name: 'get_status', arguments: { verbose: true } }]);
  assert.deepEqual(parsed.usage, { inputTokens: 7, outputTokens: 5, totalTokens: 12 });
  assert.equal(parsed.finishReason, 'tool_calls');
});

test('manual response mapping surfaces mapped provider errors', () => {
  assert.throws(
    () => adapters.parseChatResponse({
      protocol: 'openai-compatible',
      responseMode: 'manual',
      response: { errorPath: 'failure.detail' },
    }, { failure: { detail: 'quota exhausted' } }),
    /quota exhausted/,
  );
});

test('model discovery accepts common response shapes', () => {
  assert.deepEqual(adapters.parseModelsResponse({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(adapters.parseModelsResponse({ models: [{ name: 'c' }, 'd'] }), ['c', 'd']);
});
