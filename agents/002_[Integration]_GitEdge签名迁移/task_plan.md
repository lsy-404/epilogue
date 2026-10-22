# GitEdge 发布签名迁移

- [x] 核对 Epilogue 所有签名提交、发布和导入消费者；确认均在 release workflows 与 scripts/release-signing.mjs。
- [x] 拆分 source payload preparation、GitHub artifact upload 与 GitEdge submission。
- [x] 让 publisher 使用 native GitEdge polling/download，并保留签名报告和资产 digest 校验。
- [x] 调整 release workflow 的 source artifacts、OIDC audience 与 Runner 凭据环境。
- [x] 更新现有 packaging/签名测试契约并保留负控制。
- [x] 运行目标测试和语法/差异检查，提交分支供主 agent 合并。
