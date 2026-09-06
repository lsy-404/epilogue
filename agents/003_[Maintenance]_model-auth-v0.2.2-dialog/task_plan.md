# 任务计划

- [x] 核对 v0.2.2 正式 release、当前 worktree 基线和既有 model-auth 宿主边界。
- [ ] 等 v0.2.3 发布后再更新 core/providers/vue 的最终正式 tarball pin；本轮不改变现有 v0.2.1 pin。
- [x] 检查 native dialog.showModal、三步进度/上一步、动效和 mounted open 控制在 Epilogue 宿主中的生命周期。
- [x] 确认宿主关闭不会销毁元素；增加根 `/test` 回归且不改认证业务。
- [x] 按最终契约仅在 select-model 成功并 refresh 后关闭，加入关闭重开迟到操作回归，不增加 confirmed prop。
- [x] 运行 v0.2.2 静态包核验、宿主回归、diff 检查并提交本分支；不安装客户端、不执行真实授权、不 push。
