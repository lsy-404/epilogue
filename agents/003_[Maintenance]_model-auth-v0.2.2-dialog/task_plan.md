# 任务计划

- [x] 核对 v0.2.2 正式 release、当前 worktree 基线和既有 model-auth 宿主边界。
- [x] v0.2.4 发布后更新 core/providers/vue 的最终正式 tarball pin。
- [x] 检查 native dialog.showModal、三步进度/上一步、动效和 mounted open 控制在 Epilogue 宿主中的生命周期。
- [x] 确认宿主关闭不会销毁元素；增加根 `/test` 回归且不改认证业务。
- [x] 按最终契约仅在 select-model 成功并 refresh 后关闭，加入关闭重开迟到操作回归，不增加 confirmed prop。
- [x] 运行 v0.2.4 静态 asset 核验、Epilogue 完整测试、diff 检查并提交本分支；不安装客户端、不执行真实授权、不 push。

## v0.2.5 最终同步

- [x] 核验正式 release 的 core/vue/providers tgz 与 standalone asset。
- [x] 只更新正式依赖和锁文件，保持宿主 JavaScript 不变。
- [x] 只读复用共享 Electron 44 dist 运行完整 54 项测试。
- [x] 核查仅有本轮范围变更，更新审计并追加本地提交，不 push。
