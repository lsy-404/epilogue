# 操作记录

- 2026-09-05：阅读 TraeCode CLI 官方环境变量文档；确认 `TRAE_HOME` 是 host 需隔离的配置/运行目录覆写。
- 2026-09-05：检查 Epilogue 当前 provider host；未发现已实现的 TraeProvider 或可验证 CLI 二进制接口，因此未修改运行时代码。
- 2026-09-05：新增严格的 Trae CLI host adapter：每一 session 使用 app-owned absolute TRAE_HOME，stdout 只按 JSONL completed/result、assistant、tool events 解析。
- 2026-09-05：改为只消费共享 TraeProvider 的 structured assistantText；macOS arm64 app package 成功生成，尚缺企业 CLI 实机验证。
