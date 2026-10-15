# 调研发现

- Epilogue 最新远端基线为 `origin/main` 的 `4ebe988`；原工作区有两条本地提交和未跟踪私有依赖包，均保留未触碰。
- 当前发布 workflow 在 tag push 时直接上传所有平台安装包；必须拆分源构建和单独的签名后发布入口，避免未签名 fallback。
- 签名中心 push 输入采用 `POST /v1/requests`（含 `input_digest`、`input_size`）→ `/source` 上传计划 → `/source/parts/{n}` 分片上传 → `/source/complete`。签名在对应源 workflow 成功后才进入队列。
- 当前可见中心策略含 `import-epilogue-arm64`，未含新发布所需的三个项目 ID；`signingAccount.windows_ready` 当前为 false。需由中心侧配置/执行器完成后才能实际端到端签名。
- `IRIS-Build/scripts/submit-macos.mjs` 实现 macOS 源上传和请求校验，但常量绑定 IRIS 的项目、包名和架构，不能直接作为 Epilogue 客户端。
- 为避开签名中心 1 小时源 run 完成窗口，构建阶段先独立完成四组平台构建（Windows x64/arm64、macOS arm64、Linux x64/arm64）；签名源作业依赖全部构建完成后才提交，并保留中心要求的三个 job name。
- 发布 workflow 使用中心的 `workflow_dispatch` 入口，输入 `build_run_id`；publisher 仅在默认分支运行，只允许成功的稳定 tag 源 run，最多等待 5 分钟以处理状态写入延迟。中心可自动 dispatch；相同入口也可人工恢复。
- 源请求 create、source-plan、每个上传分片和 source-complete 都使用新获取的 GitHub OIDC run identity（audience 固定为签名中心），同时保留仓库签名 API key 的主认证。
- 发布侧按中心状态和源 run 元数据绑定请求，校验下载 ZIP 摘要、中心报告、签名产品 SHA-256 和各平台关键签名标志后才组装发布目录。Windows `.nupkg` 使用签名报告给出的实际文件名，以保持 `RELEASES` 引用有效。
