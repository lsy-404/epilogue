# 任务计划

- [x] 核对 worktree 基线、现有 provider UI、共享包公开接口。
- [x] 定义 Epilogue 的 model-auth host 状态与 action 到现有 IPC/设置/推理的映射。
- [x] 替换旧 onboarding UI，并保留实际可用的目录、OAuth、API key、模型与策略操作。
- [x] 让多账户/密钥 enabled、weight 和 OAuth/provider/strategy 选择影响真实推理路径。
- [x] 添加根目录 `/test` 的覆盖并运行审计、测试与构建验证。
- [ ] 修复 OAuth 重连、models.dev 绑定、路由 ID 隔离、模型选择、后端凭据校验和安全错误边界。
- [ ] 使用共享 CredentialRouter 替换账户池手写路由，并对真实请求成功/失败做健康回报。
- [ ] 审查 diff 并提交独立 task worktree 变更。
