# 任务计划

- [x] 核对官方 CLI 环境变量与现有 host 接入状态。
- [x] 定义对 `TraeProvider` 模块、企业 CLI status 和 JSONL 完成事件的严格边界。
- [x] 为单一应用 session 创建绝对路径的 app-owned `TRAE_HOME`，并经 adapter 执行 status/login/logout/execute。
- [x] 将 adapter 的结构化 assistantText/toolCalls 映射为模型响应；仅在 status 已认证时显示可用。
- [ ] 安装 v0.2 release、添加根目录 `/test` 覆盖，并验证真实企业 CLI 流程后提交。
- [x] 覆盖账号默认模型的 request shaping；native smoke 使用主代理的隔离 userData entry。
