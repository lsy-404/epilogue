'use strict';
// IRIS-style provider boundary for Epilogue.
//
// The renderer persists one neutral provider record. This module owns the
// protocol-specific request/response shapes so the rest of Epilogue never has
// to branch on OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages.

const PROTOCOLS = Object.freeze({
  OPENAI_COMPATIBLE: 'openai-compatible',
  OPENAI_COMPLETIONS: 'openai-completions',
  OPENAI_RESPONSES: 'openai-responses',
  ANTHROPIC_MESSAGES: 'anthropic-messages',
});

const SUPPORTED_PROTOCOLS = new Set(Object.values(PROTOCOLS));
const MANAGED_BODY_FIELDS = new Set([
  'messages',
  'input',
  'instructions',
  'system',
  'tools',
  'tool_choice',
  'model',
  'stream',
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function protocolOf(provider) {
  return SUPPORTED_PROTOCOLS.has(provider?.protocol) ? provider.protocol : PROTOCOLS.OPENAI_COMPLETIONS;
}

function defaultRequestPath(protocol) {
  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES) return '/messages';
  if (protocol === PROTOCOLS.OPENAI_RESPONSES) return '/responses';
  return '/chat/completions';
}

function joinEndpointUrl(baseUrl, requestPath) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const suffix = String(requestPath || '').trim().replace(/^\/+/, '');
  if (!base) throw new Error('Base URL is required');
  return suffix ? `${base}/${suffix}` : base;
}

function endpointFor(provider, kind = 'chat') {
  if (kind === 'models') return joinEndpointUrl(provider.baseUrl, provider.modelsPath || '/models');
  return joinEndpointUrl(provider.baseUrl, provider.requestPath || defaultRequestPath(protocolOf(provider)));
}

function requestHeaders(provider, extra = {}) {
  const protocol = protocolOf(provider);
  const custom = record(provider?.headers);
  const out = { ...custom, ...extra };
  const key = String(provider?.apiKey || (Array.isArray(provider?.apiKeys) ? provider.apiKeys[0] : '') || '').trim();
  if (key) {
    const header = String(provider?.authHeader || '').trim() ||
      (protocol === PROTOCOLS.ANTHROPIC_MESSAGES ? 'x-api-key' : 'Authorization');
    const prefix = typeof provider?.authPrefix === 'string'
      ? provider.authPrefix
      : protocol === PROTOCOLS.ANTHROPIC_MESSAGES ? '' : 'Bearer ';
    out[header] = `${prefix}${key}`;
  }
  if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES && !Object.keys(out).some((keyName) => keyName.toLowerCase() === 'anthropic-version')) {
    out['anthropic-version'] = '2023-06-01';
  }
  if ((provider?.baseUrl || '').includes('openrouter.ai')) {
    out['HTTP-Referer'] = 'https://github.com/Wuyilingwei/epilogue';
    out['X-Title'] = 'Epilogue';
  }
  return out;
}

function mergeBody(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const forbidden = Object.keys(patch).filter((key) => MANAGED_BODY_FIELDS.has(key));
  if (forbidden.length) throw new Error(`Provider body cannot override managed request field(s): ${forbidden.join(', ')}`);
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeBody(record(out[key]), value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJsonPath(value, path) {
  if (!String(path || '').trim()) return undefined;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').map((part) => part.trim()).filter(Boolean);
  let cursor = value;
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (typeof cursor === 'object') cursor = cursor[part];
    else return undefined;
  }
  return cursor;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      return typeof block.text === 'string' ? block.text : typeof block.output_text === 'string' ? block.output_text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function genericTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    parameters: tool.parameters || { type: 'object', properties: {} },
  }));
}

function openAIMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        ...(message.name ? { name: message.name } : {}),
        content: textContent(message.content),
      };
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      return {
        role: 'assistant',
        content: textContent(message.content) || null,
        tool_calls: message.toolCalls.map((call, index) => ({
          id: call.id || `call_${index + 1}`,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      };
    }
    return { role: message.role, content: textContent(message.content) };
  });
}

function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: textContent(message.content) });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      if (textContent(message.content)) input.push({ role: 'assistant', content: textContent(message.content) });
      for (const [index, call] of message.toolCalls.entries()) {
        input.push({
          type: 'function_call',
          call_id: call.id || `call_${index + 1}`,
          name: call.name,
          arguments: JSON.stringify(call.arguments || {}),
        });
      }
      continue;
    }
    input.push({ role: message.role, content: textContent(message.content) });
  }
  return input;
}

function anthropicMessages(messages) {
  const output = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result = { type: 'tool_result', tool_use_id: message.toolCallId, content: textContent(message.content) };
      // Anthropic requires every tool result for one assistant turn in the
      // following user message. Multiple adjacent user messages are rejected.
      const previous = output.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((item) => item.type === 'tool_result')) {
        previous.content.push(result);
      } else {
        output.push({ role: 'user', content: [result] });
      }
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length) {
      const content = [];
      if (textContent(message.content)) content.push({ type: 'text', text: textContent(message.content) });
      for (const [index, call] of message.toolCalls.entries()) {
        content.push({ type: 'tool_use', id: call.id || `call_${index + 1}`, name: call.name, input: call.arguments || {} });
      }
      output.push({ role: 'assistant', content });
      continue;
    }
    output.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: textContent(message.content) });
  }
  return output;
}

function buildChatRequest(provider, messages, options = {}) {
  const protocol = protocolOf(provider);
  const tools = genericTools(options.tools);
  const systems = messages.filter((message) => message.role === 'system').map((message) => textContent(message.content)).filter(Boolean);
  let body;
  if (protocol === PROTOCOLS.OPENAI_RESPONSES) {
    body = {
      model: provider.model,
      ...(systems.length ? { instructions: systems.join('\n\n') } : {}),
      input: responsesInput(messages),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', ...tool })) } : {}),
    };
    if (options.maxTokens) body.max_output_tokens = options.maxTokens;
  } else if (protocol === PROTOCOLS.ANTHROPIC_MESSAGES) {
    body = {
      model: provider.model,
      max_tokens: options.maxTokens || provider.maxTokens || 4096,
      ...(systems.length ? { system: systems.join('\n\n') } : {}),
      messages: anthropicMessages(messages),
      ...(tools.length ? { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
    };
  } else {
    body = {
      model: provider.model,
      messages: openAIMessages(messages),
      ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
    };
    if (options.json) body.response_format = { type: 'json_object' };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
  }
  if (Number.isFinite(options.temperature) && provider.omitTemperature !== true) body.temperature = options.temperature;
  return mergeBody(body, provider.body);
}

function jsonArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}

function normalizeToolCall(value, index) {
  const item = record(value);
  const fn = record(item.function);
  const name = String(item.name || fn.name || '').trim();
  if (!name) return null;
  return {
    id: String(item.id || item.call_id || `call_${index + 1}`),
    name,
    arguments: jsonArguments(item.arguments ?? item.input ?? fn.arguments),
  };
}

function usageOf(input, output) {
  const asNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const inputTokens = asNumber(input);
  const outputTokens = asNumber(output);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function parseChatResponse(provider, value) {
  const protocol = protocolOf(provider);
  const root = record(value);
  if (root.error) {
    const err = record(root.error);
    throw new Error(String(err.message || root.error));
  }
  if (provider?.responseMode === 'manual') {
    const paths = record(provider.response);
    const mappedError = readJsonPath(value, paths.errorPath);
    if (mappedError !== undefined && mappedError !== null && mappedError !== '') {
      throw new Error(typeof mappedError === 'string' ? mappedError : JSON.stringify(mappedError));
    }
    const rawCalls = readJsonPath(value, paths.toolCallsPath);
    const toolCalls = (Array.isArray(rawCalls) ? rawCalls : rawCalls ? [rawCalls] : []).map(normalizeToolCall).filter(Boolean);
    const input = readJsonPath(value, paths.inputTokensPath);
    const output = readJsonPath(value, paths.outputTokensPath);
    return {
      text: textContent(readJsonPath(value, paths.textPath)),
      toolCalls,
      finishReason: readJsonPath(value, paths.stopReasonPath) || (toolCalls.length ? 'tool_calls' : 'stop'),
      usage: usageOf(input, output),
    };
  }
  if (protocol === PROTOCOLS.OPENAI_COMPLETIONS || protocol === PROTOCOLS.OPENAI_COMPATIBLE) {
    const choice = record(Array.isArray(root.choices) ? root.choices[0] : undefined);
    const message = record(choice.message);
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(normalizeToolCall).filter(Boolean);
    const usage = record(root.usage);
    return {
      text: textContent(message.content),
      toolCalls,
      finishReason: choice.finish_reason || (toolCalls.length ? 'tool_calls' : 'stop'),
      usage: usageOf(usage.prompt_tokens, usage.completion_tokens),
    };
  }
  if (protocol === PROTOCOLS.OPENAI_RESPONSES) {
    const output = Array.isArray(root.output) ? root.output : [];
    const texts = [];
    const toolCalls = [];
    for (const item of output) {
      const block = record(item);
      if (block.type === 'message') {
        const content = Array.isArray(block.content) ? block.content : [];
        texts.push(textContent(content));
      }
      if (block.type === 'function_call') {
        const call = normalizeToolCall(block, toolCalls.length);
        if (call) toolCalls.push(call);
      }
    }
    const usage = record(root.usage);
    return {
      text: typeof root.output_text === 'string' ? root.output_text : texts.filter(Boolean).join('\n'),
      toolCalls,
      finishReason: toolCalls.length ? 'tool_calls' : record(root.incomplete_details).reason || 'stop',
      usage: usageOf(usage.input_tokens, usage.output_tokens),
    };
  }
  const content = Array.isArray(root.content) ? root.content : [];
  const texts = [];
  const toolCalls = [];
  for (const item of content) {
    const block = record(item);
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'tool_use') {
      const call = normalizeToolCall(block, toolCalls.length);
      if (call) toolCalls.push(call);
    }
  }
  const usage = record(root.usage);
  return {
    text: texts.join('\n'),
    toolCalls,
    finishReason: root.stop_reason || (toolCalls.length ? 'tool_use' : 'stop'),
    usage: usageOf(usage.input_tokens, usage.output_tokens),
  };
}

function parseModelsResponse(value) {
  const root = record(value);
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : Array.isArray(value) ? value : [];
  return [...new Set(list.map((entry) => {
    if (typeof entry === 'string') return entry.trim();
    const item = record(entry);
    return String(item.id || item.slug || item.name || '').trim();
  }).filter(Boolean))];
}

function adapterInfo(provider) {
  const protocol = protocolOf(provider);
  return {
    protocol,
    requestUrl: endpointFor(provider, 'chat'),
    modelsUrl: endpointFor(provider, 'models'),
  };
}

module.exports = {
  PROTOCOLS,
  SUPPORTED_PROTOCOLS,
  protocolOf,
  endpointFor,
  joinEndpointUrl,
  requestHeaders,
  buildChatRequest,
  parseChatResponse,
  parseModelsResponse,
  adapterInfo,
  mergeBody,
  readJsonPath,
};
