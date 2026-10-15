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

- 主任务整合到独立 integration 工作树，保留原始主工作树两个本地提交与私有依赖目录；锁定安装后既有 98 项 Node 检查全部通过。
- 既有工作流供应链案例按源/发布拆分后的实际职责调整；未新增测试案例。

- Azure federation 已改为实际不可变 OIDC sub；修复 Mac 报告阶段摘要校验，既有 98 条测试和 actionlint 通过。新发布候选 0.5.1，保留旧候选标签。

- 0.5.1 源 run 38799586669 成功；macOS 请求签名、公证完成，本机 Get-Sign 验证镜像内 Epilogue 0.5.1 为 PASS、DefaultPassed、VerifiedStapled。Windows ARM64 有限重试已耗尽，固定配方失败于 codesign；尚未发布 GitHub Release。
- 保留 v0.5.0/v0.5.1 标签及既有审计，使用 0.5.2 新候选重新构建，避免移动标签或复用终态请求；签名中心继续修复实际 Windows 失败后由统一发布工作流收齐三平台结果。
- 0.5.2 的 Mac 最终 DMG 及内部应用已用本机 Get-Sign 验收，版本 0.5.2、PASS、DefaultPassed / Distribution Passed、VerifiedStapled；Windows x64 在修正 SDK 返回值前耗尽有限重试，整个候选未发布。保留既有标签，使用 0.5.3 新源请求消费修正后的固定 Windows 配方。
- 0.5.3 的 Mac 最终阶段经过有限重试后仍失败，历史阶段码 stapling 覆盖了后续多个验证步骤，不能据此断定为 Apple 服务错误。中心已将最终 DMG / App 的签名、票据、Gatekeeper、挂载、布局及输出阶段分别标记，保留所有原验证；使用 0.5.4 新候选重新取得可核实的结果，不移动旧标签或复用终态请求。
