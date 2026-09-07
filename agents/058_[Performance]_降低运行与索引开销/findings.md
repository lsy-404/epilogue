# 发现

- 项目是 Electron + CommonJS + 原生 renderer，已有向量流读、延迟加载和托盘回收。
- 工作树 main 干净，HEAD f4bc64e；agents 为指向 F:/Development/agents_memory/epilogue 的现有符号链接，保持位置不变。
- 索引保存全量重写二进制向量；扫描和主进程同步 fs、空闲模型进程生命周期需要进一步检查。
- 仓库未指定专属 worktree 位置。按用户规则在 Windows 对应的 C:/Users/User/.codex/worktrees/epilogue 内创建隔离 worktree，不移动已有工作树。
- 用户要求优化性能和开销；无新增依赖、产品功能扩展和兼容层的预设需求。
- 15 分钟进度检查首次自动审批误判为未授权；附用户工作流原文再次尝试。

- 远程 main 未保护，提交 3d80b0f，比本地多 19 个共享模型认证相关提交；修改前已快进任务分支到最新上游。现有 agents junction 保持，但远程 tracked project/tasks 更新了索引；历史任务目录和当前 058 完整保留，当前任务已重新加入上游索引。

- 子 agent 复审确认：关窗卸载 store 单例时异步任务仍持旧实例，再打开窗口会新建第二实例，延迟写盘可能覆盖。托盘定时任务结束后也未释放元数据。决定用统一 withStore 使用计数延迟卸载，避免并发实例与空闲常驻。
- 分页基准 25k：全量 11,341,671 bytes/46.59ms，单页113,076 bytes/0.85ms（7次中位数，模拟数据）。recent 初版正向有序插入14.8ms慢于原排序2.17ms，改反向扫描后1.71ms；仅保留实测不退步版本。
- Electron沙箱冒烟首次 GPU 子进程失败、ERR_FAILED；授权隔离运行后通过真实隐藏窗口：启动0行、首屏400、追加800、筛选1。
