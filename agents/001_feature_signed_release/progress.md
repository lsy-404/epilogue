# 进度

- 2026-10-15：读取全局规则与 Agent Mode；fetch `origin`，确认最新主线为 `4ebe988`，创建固定位置 worktree `codex/signed-release-0.5.0`。
- 2026-10-15：核对 Epilogue tag 发布 workflow、packager/Windows Squirrel 脚本及 signing-center API 契约。发现中心当前无 Epilogue 0.5 发布项目且 Windows 未就绪，已向主 agent 报告待决契约。
- 2026-10-15：将原 tag 直发流程改为构建/签名源提交和独立发布 workflow；三个签名源 job 等待全部平台构建结束后提交，以满足中心的源 run 时限。
- 2026-10-15：新增源打包、OIDC 身份绑定、分片上传、签名状态读取、签名 ZIP/verification report/产品摘要核验和校验和生成逻辑；新增默认分支手动恢复发布入口，中心可按 build_run_id 自动 dispatch。
- 2026-10-15：版本提升到 0.5.0；更新中英文 README 发布步骤，注明中心自动 dispatch 和 24 小时输出保留窗。
- 2026-10-15：`node --check scripts/release-signing.mjs`、`actionlint`（两份 workflow）、`git diff --check`、`pnpm install --lockfile-only --offline --frozen-lockfile` 均通过；没有新增或执行测试。
- 2026-10-15：提交聚焦改动 `e3a41a2`；未推送。仓库 `.git/info/exclude` 忽略 `/agents`，因此 Agent Mode 记录保留在本地而不纳入源码提交。

- 主任务已审阅并修复 Linux 临时安装工具 NODE_PATH；为 Windows 源包保留原产品安装器 ICO。
- 本地源代码和工作流检查已通过，远端发布及原生分发包验收仍待执行，不以本地提交视为完成。
