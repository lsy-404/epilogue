# 调研记录

- [现状] worktree 位于 `codex/shared-model-auth`，基线为 `f4bc64e` 且初始工作区干净。
- [共享接口] `packages/vue/src/useModelAuth.ts` 定义了 host 的 `getState`、`execute` 以及 OAuth、API key、凭据、provider、模型、策略、目录刷新 actions。
- [现状] Epilogue 的旧 renderer onboarding 将 OAuth 卡片、models.dev 目录和自定义兼容 API 编辑器拆开；主进程 provider 记录已被实际推理模块使用。
- [映射] 新 host 只公布 models.dev 中现有 bundled adapter 可用的 API-key providers，以及已有真实 OAuth 协议的 provider；TRAE sidecar 尚未提供，未列为可用连接。
- [推理] 每个新增 OAuth 账户或 API key 都是独立 chat record；`llm.withFailover` 先按 provider 的 round-robin、weighted-round-robin 或 failover 选择凭据，再沿原顺序回退。
- [协调] WorkBuddy 已有 `@model-auth/providers/workbuddy` 0.2.0 契约；Epilogue 动态导入该 ESM 模块，安全存储和多账户 ID 仍由本地 host 负责。
- [取消] dialog close 发出 host operation ID 取消；IPC 持有对应 AbortController 并将 signal 传给共享 WorkBuddy authorize 函数，不会继续十分钟的登录轮询。
- [开关] provider OAuth 总开关在 `llm.withFailover` 前过滤 OAuth route；各账户自己的 enabled 状态仍独立保留，重新开启 provider 时无需重连或重设权重。
- [审查] 原 host 未监听 reconnect 事件、OAuth/API provider ID 可冲突、OAuth 模型列表为静态值，且选择模型会批量写路由；这些都必须在本任务完成前修复。
- [审查] 手写加权轮换重复了共享 core 的 CredentialRouter；账户池路由应改用 core 并回报实际成功/失败以保留 cooldown 和永久认证失败状态。
- [复审] Trae status 不含 models；不从不存在字段取值。Anthropic/OpenAI OAuth 与 API key 合并到同一 canonical models.dev runtime；WorkBuddy 缺失 runtime binding 时不可用。
- [WorkBuddy] 原生 verified runtime ID 列表只与 zhipuai、deepseek、tencent-tokenhub 的 models.dev 原始 model ID 做逐字交集；未命中的 capability 和任何别名均不展示。
