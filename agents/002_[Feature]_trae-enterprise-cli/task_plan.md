# 任务计划

- [x] 核对官方 CLI 环境变量与现有 host 接入状态。
- [x] 定义对 `TraeProvider` 模块、企业 CLI status 和 JSONL 完成事件的严格边界。
- [x] 为每个应用/凭据创建绝对路径的 app-owned `TRAE_HOME`，并经 adapter 执行 status/login/logout/execute。
- [x] 将 JSONL 结果解析为结构化模型响应和工具调用；仅在 status 已认证时显示可用。
- [ ] 添加根目录 `/test` 覆盖、验证真实企业 CLI 流程并提交（共享 TraeProvider 仍未可用）。
