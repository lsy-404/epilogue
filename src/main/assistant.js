'use strict';
// Epilogue agent runtime: Observe → Plan → Act → Verify.
//
// Read-only tools may execute inside the bounded loop. Any settings mutation is
// staged and requires an explicit renderer approval before this module applies
// it. Native provider tool calls are preferred; the legacy JSON envelope stays
// as a compatibility path for free endpoints without function calling.

const crypto = require('crypto');
const settings = require('./settings');
const llm = require('./llm');
const { makeT } = require('../shared/locales');
const proto = require('../shared/assistantProtocol');
const tools = require('./assistantTools');

const MAX_HISTORY = 16;
const MAX_TOOL_ROUNDS = 4;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const pendingApprovals = new Map();

function pruneApprovals() {
  const cutoff = Date.now() - APPROVAL_TTL_MS;
  for (const [id, item] of pendingApprovals) if (item.createdAt < cutoff) pendingApprovals.delete(id);
}

function buildSystemPrompt(cfg) {
  const lang = cfg.language === 'en' ? 'English' : '中文';
  return [
    '你是 Epilogue 的内置文件工作流 agent。Epilogue 在本机索引文件内容、查找文件，并按用户明确的习惯协助整理。',
    `界面语言：${lang}。默认用该语言回复；用户切换语言时跟随用户。`,
    `当前安全设置摘要：${JSON.stringify(tools.settingsDigest(cfg))}`,
    '',
    '工作方式：先理解目标，再选择最少的工具；读取后核对结果；说明已知事实与不确定性。',
    'search_files 与 get_status 是只读工具，可以直接使用。update_settings 只提交变更建议，应用会要求用户明确确认后才执行。',
    '不要声称尚待确认的变更已经生效。不要尝试修改 provider、API Key、文件路径或白名单外设置。',
    '用户说“记住/以后……”时，可在保留仍有效旧条目的前提下，提议把简短规则合并进 rules。',
    '',
    '若当前模型不支持原生工具调用，严格输出一个 JSON 对象作为兼容协议，不要添加代码围栏：',
    '{"reply":"给用户看的话","actions":[{"tool":"工具名","args":{}}]}',
    '无需工具时 actions=[]。可用工具仅为 update_settings、search_files、get_status。',
  ].join('\n');
}

function providerEvent(completion) {
  const provider = completion.provider || {};
  return {
    type: 'model_used',
    detail: [provider.name, provider.model].filter(Boolean).join(' · '),
    protocol: provider.protocol,
  };
}

function stageApproval(action) {
  const prepared = tools.prepareSettingsUpdate(action.args);
  if (!prepared.ok) {
    return { result: { tool: action.tool, ok: false, error: 'no allowed settings in patch', rejected: prepared.rejected } };
  }
  pruneApprovals();
  const id = crypto.randomUUID();
  const approval = {
    id,
    tool: action.tool,
    summary: prepared.summary,
    changes: prepared.changes,
    patch: prepared.patch,
    rejected: prepared.rejected,
    createdAt: Date.now(),
  };
  pendingApprovals.set(id, approval);
  return {
    approval: {
      id,
      tool: action.tool,
      summary: prepared.summary,
      changes: prepared.changes,
      rejected: prepared.rejected,
      expiresAt: approval.createdAt + APPROVAL_TTL_MS,
    },
  };
}

function fallbackActions(completion) {
  if (!completion.text) return { reply: '', actions: [] };
  const parsed = proto.parseAssistantOutput(completion.text, llm.parseJsonLoose);
  return parsed || { reply: completion.text.trim(), actions: [] };
}

async function requestCompletion(providers, messages) {
  try {
    return await llm.chatCompletionF(providers, messages, {
      temperature: 0.3,
      tools: proto.TOOL_DEFINITIONS,
    });
  } catch (nativeError) {
    const message = String(nativeError.message || nativeError);
    const status = Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
    const formatRejected = [400, 404, 405, 415, 422].includes(status) || /unsupported.{0,30}(tool|function)|tool.{0,30}not supported/i.test(message);
    if (!formatRejected) throw nativeError;
    require('./log').log('assistant', 'native tool request failed; retrying compatibility mode', {
      error: message.slice(0, 200),
    });
    return llm.chatCompletionF(providers, messages, { temperature: 0.3 });
  }
}

// One turn. Returns a final reply plus trace events and optional approvals.
async function chatTurn(history, hooks = {}) {
  const cfg = settings.get();
  const t = makeT(cfg.language);
  const messages = [
    { role: 'system', content: buildSystemPrompt(cfg) },
    ...history.slice(-MAX_HISTORY).map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content ?? ''),
    })),
  ];
  const events = [];
  const approvals = [];
  let lastReply = '';
  let providerSeen = false;
  let toolCount = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await requestCompletion(cfg.providers.chat, messages);
    if (!providerSeen) {
      events.push(providerEvent(completion));
      providerSeen = true;
    }

    const nativeActions = proto.normalizeNativeToolCalls(completion.toolCalls);
    const fallback = nativeActions.length ? { reply: completion.text.trim(), actions: [] } : fallbackActions(completion);
    const actions = nativeActions.length
      ? nativeActions
      : fallback.actions.map((action, index) => ({ ...action, id: `compat_${round + 1}_${index + 1}` }));
    lastReply = fallback.reply || completion.text.trim() || lastReply;
    if (!actions.length) {
      return {
        reply: lastReply || t('err', { msg: 'model returned an empty response' }),
        events,
        approvals,
        trace: { rounds: round + 1, toolCount },
      };
    }

    const { log } = require('./log');
    log('assistant', `round ${round + 1}: ${actions.length} action(s)`, { tools: actions.map((action) => action.tool) });
    const results = [];
    for (const action of actions) {
      toolCount++;
      if (proto.WRITE_TOOLS.has(action.tool)) {
        const staged = stageApproval(action);
        if (staged.approval) {
          approvals.push(staged.approval);
          events.push({ type: 'approval_requested', detail: staged.approval.summary });
        } else {
          results.push({ id: action.id, ...staged.result });
        }
        continue;
      }
      try {
        results.push({ id: action.id, ...(await tools.executeReadTool(action.tool, action.args, events)) });
      } catch (error) {
        log('assistant', `tool failed: ${action.tool}`, { error: String(error.message || error).slice(0, 200) });
        results.push({ id: action.id, tool: action.tool, ok: false, error: String(error.message || error).slice(0, 200) });
      }
    }

    if (approvals.length) {
      return {
        reply: lastReply || t('chat_approval_needed'),
        events,
        approvals,
        trace: { rounds: round + 1, toolCount },
      };
    }

    if (nativeActions.length) {
      messages.push({ role: 'assistant', content: completion.text, toolCalls: completion.toolCalls });
      for (const result of results) {
        messages.push({ role: 'tool', toolCallId: result.id, name: result.tool, content: JSON.stringify(result) });
      }
    } else {
      messages.push({ role: 'assistant', content: completion.text });
      messages.push({
        role: 'user',
        content: `[tool results]\n${JSON.stringify(results)}\n据此核对并给最终答复；仍使用兼容 JSON 协议。`,
      });
    }
  }

  return {
    reply: lastReply || t('err', { msg: 'assistant loop exhausted' }),
    events,
    approvals,
    trace: { rounds: MAX_TOOL_ROUNDS, toolCount, exhausted: true },
  };
}

function resolveApproval(id, approved, hooks = {}) {
  pruneApprovals();
  const item = pendingApprovals.get(String(id));
  if (!item) throw new Error('This approval is missing or expired');
  pendingApprovals.delete(String(id));
  const t = makeT(settings.get().language);
  if (!approved) {
    return {
      reply: t('chat_change_cancelled'),
      events: [{ type: 'approval_rejected', detail: item.summary }],
      approvals: [],
    };
  }
  tools.applySettingsUpdate(item.patch, hooks);
  return {
    reply: t('chat_change_applied', { detail: item.summary }),
    events: [{ type: 'settings_updated', detail: item.summary }, { type: 'approval_accepted', detail: item.summary }],
    approvals: [],
  };
}

module.exports = { chatTurn, resolveApproval, buildSystemPrompt, pruneApprovals };
