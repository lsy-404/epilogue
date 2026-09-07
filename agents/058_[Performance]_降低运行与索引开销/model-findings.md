# 调研记录

- 当前 `idleShutdown` 仅检查父进程 pending 调用，随后 `restartHost` 直接 kill 子进程。
- 当前 exit 回调无子进程身份校验；旧进程在新进程启动后退出，可能清空新进程引用并拒绝新 pending 请求。
- 窗口关闭在主进程事件循环中同步执行，因此在空闲检查和 kill 之间不会插入 IPC 调用；真正的竞态发生在旧 child 的异步 `exit` 与后续 `ensureChild` 之间。
- 解决方式：每个 pending 调用记录其投递 child；exit 仅在 child 仍为当前实例时清除引用，并且只拒绝投递给该实例的请求。
- 关闭窗口时设置延迟回收标记；最后一个调用结算后以 `setImmediate` 检查，从而让同一轮 Promise continuation 发起的前台后续调用先登记。
- 窗口打开会取消延迟回收，避免用户返回界面时终止仍在执行的模型请求。
- 已新增模型生命周期单测：繁忙不终止、结算后回收、重开取消回收、旧 host exit 不影响 replacement 请求。
## 设置变更与批量调用

- `settings:set`、provider OAuth/来源添加等均调用 `applyAppSettings`，因此无关设置会触发当前无条件的 `restartHost`。
- `indexFolder` 在每个文件前以 `setImmediate` 让出事件循环；当前仅一轮 `setImmediate` 的空闲检测可能先于下一文件的调用执行，导致托盘态批量索引反复重启宿主。
- `applyHostSettings` 只比较 `app.hfMirror` 与 `imageEmbed.device`，首次调用记录基线而不重启；其余设置保存不再中断模型请求。
- 托盘空闲意图默认开启（隐藏启动无窗口），在打开窗口时取消；即使当时没有 child，也会保留到后续调用结束。
- 每次模型调用清除已有回收 timer，最后一次结算后等待 5 秒；timer 以 unref 方式运行，不会阻止应用退出。批量索引的 `setImmediate` 间隙不会重启模型。
- `restartHost` 只清 timer、不清托盘空闲意图，因此环境变更后的后续托盘调用仍会被回收。
## Store 生命周期复审

- `withStore` 在进入时增加 `storeUsers`，以 `finally` 减少计数，并只在 `unloadRequested` 时再次调用 `unloadStore`；关闭窗口跨 await 不会置空正在使用的 store，也不会创建第二实例。
- `resumeStore` 在任务结束前将 `unloadRequested` 清除，前台恢复后不会被旧任务 finally 卸载。
- `unloadStore` 的 flush 或日志异常会保留 store 引用与卸载意图；下一次释放或关闭可重试，未见不可恢复的半卸载状态。
## 回收持久性与投递失败

- timer 回调将 `shutdownWhenIdle` 设为 false，首次模型回收后，后续托盘任务不再安排回收。
- `postMessage` 是同步调用；若其抛错，当前 Promise executor 会 reject，但 pending Map 中的条目不会删除，导致以后始终被判定为忙碌。
- timer 回调不再清除 `shutdownWhenIdle`；首次回收后的后续托盘任务仍会在完成后安排回收。
- `call` 捕获同步 postMessage 异常、删除对应 pending、拒绝请求，并按现有 tray 意图安排空闲回收。

## 旧宿主退出后的空闲回收

- 旧 host 被重启后仍有 pending；新 host 先完成时，pending Map 非空导致不安排回收。旧 host exit 清理最后一个 pending 后必须再次调用 `scheduleIdleShutdown`。
- old host exit 在清理其 pending 后调用 `scheduleIdleShutdown`；若 replacement 已空闲且 tray intent 有效，会恢复其遗漏的回收 timer。
