# 操作记录

- 已读取 agent-mode 工作流、项目索引、模型客户端与宿主实现。
- 审查确认空闲关停不打断 pending；识别旧 child exit 影响新 child 的竞态。
- 修改 localModels.js：按 host 关联 pending、为旧 exit 隔离状态、延迟空闲回收。
- 修改 index.js：打开窗口时取消延迟回收。
- 添加 test/localModels.test.js；先运行 focused suite 通过，再通过 worktree node_modules junction 运行 `npm test`，49 项全部通过。
- 审查 applyAppSettings 调用链和 indexer 批量循环；开始收敛设置触发的模型重启。
- 收敛 applyAppSettings：仅镜像或图形推理设备变化时重启 model host。
- 将托盘回收改为可持续的 5 秒 quiet period，并为测试模拟 timer。
- `npm test`：52 项全部通过。
- 只读复审主仓 IPC storeUsers/withStore/resumeStore；开始在 openWindow 接入 resumeStore。
- 在 index.js 的 openWindow 首部调用 ipc.resumeStore；未修改 IPC。
- npm test：52 项全部通过。

- 复审发现 tray idle 意图与 postMessage 同步异常的两个遗留回归，开始修复。
- 修复持续 tray idle 意图与 postMessage 抛错 pending 清理；新增两项回归测试。
- npm test：53 项全部通过。

- 开始修复旧 host pending 与新 host 完成的回收排序。
- 在旧 host exit 清理后重新安排空闲回收；添加精确事件顺序测试。
- npm test：54 项全部通过。
