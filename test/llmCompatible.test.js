'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/main/llm');

test('Compatible SDK sends OpenAI-compatible chat requests with configured overlays', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (input, init = {}) => {
    captured = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)),
    };
    return new Response(JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 1,
      model: 'compatible-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'SDK connected' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await llm.chatCompletion({
      id: 'compatible-test',
      name: 'Compatible Test',
      protocol: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      requestPath: '/vendor/chat',
      apiKeys: ['sdk-secret'],
      model: 'compatible-model',
      headers: { 'X-Tenant': 'epilogue' },
      body: { vendor_options: { latency: 'low' } },
    }, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Ping' }], { temperature: 0 });

    assert.equal(captured.url, 'https://example.test/v1/vendor/chat');
    assert.equal(captured.headers.authorization, 'Bearer sdk-secret');
    assert.equal(captured.headers['x-tenant'], 'epilogue');
    assert.equal(captured.body.model, 'compatible-model');
    assert.deepEqual(captured.body.vendor_options, { latency: 'low' });
    assert.equal(result.text, 'SDK connected');
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    assert.equal(result.provider.protocol, 'openai-compatible');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Compatible manual mode uses response-field mappings without the SDK parser', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    payload: { answer: 'Manual connected' },
    accounting: { prompt: 3, completion: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const result = await llm.chatCompletion({
      id: 'manual-compatible-test',
      protocol: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      requestPath: '/manual',
      apiKey: 'secret',
      model: 'manual-model',
      responseMode: 'manual',
      response: {
        textPath: 'payload.answer',
        inputTokensPath: 'accounting.prompt',
        outputTokensPath: 'accounting.completion',
      },
    }, [{ role: 'user', content: 'Ping' }]);
    assert.equal(result.text, 'Manual connected');
    assert.equal(result.usage.totalTokens, 4);
  } finally {
    global.fetch = originalFetch;
  }
});

test('WorkBuddy SSE responses are aggregated into an OpenAI chat completion', () => {
  const result = llm.aggregateSseChatCompletion([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    'data: [DONE]',
  ].join('\n'));
  assert.equal(result.choices[0].message.content, 'Hello');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"q":"x"}');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
});
