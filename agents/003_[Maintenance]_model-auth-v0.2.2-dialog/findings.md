# 调研记录

- [发布核验] GitHub `lsy-404/model-auth` v0.2.2 已存在，页面显示为最新 release；依赖应使用同名 core/vue/providers tgz。
- [包行为] 直接检查 v0.2.2 Vue tarball：原生 `<dialog>` 调用 `showModal()`/`close()`，关闭动画结束前保持渲染，三步标题/步数和上一步事件由共享包实现。
- [宿主生命周期] Epilogue 的 `model-auth-dialog` 常驻 `index.html`；宿主只切换 `dialog.open`，close 事件取消操作并设回 `open = false`，没有 remove/unmount 路径，因此无需宿主代码修正。
- [范围] 本任务只更新共享包版本和弹窗宿主生命周期回归，不修改认证协议、凭据存储、模型路由或真实授权流程。
- [版本门槛] v0.2.4 正式 release 已提供 core/vue/providers tgz 与 standalone asset；最终 pin 更新到 v0.2.4。
- [最终交互契约] 不增加 `confirmed` prop；共享 UI 仅在最终确认时 emit `select-model`，宿主成功执行并 refresh 后关闭，失败保持打开。
- [迟到动作] 宿主用 dialog session epoch 与 operation ID 双重校验；关闭重开后旧操作完成不得关闭新弹窗。

## v0.2.5 正式归档同步

- [发布等待] 首次 API 返回 404；本轮短暂等待后确认正式 release 发布于 2026-09-06 02:56:33 UTC，未建立 monitor。
- [归档核验] 三份 tgz 与 standalone 均 HTTP 200，下载大小和 SHA-256 与 GitHub release 元数据一致。
- [CSS 时序] 安装后的 CSS 中进度填充与确认按钮出现延迟共用 `--model-auth-progress-duration`，默认 `.4s`；宿主无需新增 JavaScript 或 prop。
- [范围核对] package-lock 只有根依赖 pin 与 core/providers/vue 三个包记录变化；`src/` 与本轮基线无差异，既有确认成功后关闭及迟到操作保护保留。
