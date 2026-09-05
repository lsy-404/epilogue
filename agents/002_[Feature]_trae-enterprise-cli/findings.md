# 调研记录

- [官方文档] `TRAE_HOME` 覆盖 Trae CLI 配置和运行时目录；`TRAECLI_PERSONAL_ACCESS_TOKEN` 是 PAT，不应写入代码、日志或共享文档。
- [当前边界] 共享 Node `TraeProvider` 仍在审查中，当前 Epilogue worktree 没有该模块或可验证的企业 CLI binary help/status 证据。
- [结论] 不添加 placeholder provider，不将个人订阅作为企业 CLI，也不把 raw stdout 当推理成功；等待 adapter 和 JSONL schema 后再实现。
- [实现] standalone model-auth entry 始终显示 Trae Enterprise CLI；仅 probe status 的 available 为 true 时才可选择，已保存 session 仅在 authenticated 时健康。共享 adapter 以 validated assistantText/toolCalls 返回推理结果，不解析 raw stdout；未验证多 profile 前仅维护单一 app session。
- [模型] CLI status 没有模型能力列表；已认证的单一 session 仅提供 `trae-account-default`，含义是 CLI 账户默认模型而非 models.dev 条目，执行时省略 `--model`。
