# 扫描与索引发现

- `indexFolder` 和 `indexDestinations` 先通过 `listFiles` 收集完整数组，再开始索引；大型目录会产生不必要的路径数组和首个进度前的等待。
- `indexDestinations` 的根仅做字面路径去重。嵌套根会重复枚举和检查同一文件。
- `stale` 每个文件需要一次 stat 才能判断时间和大小；Dirent 不携带这些元数据，无法在保持结果字段的前提下消除该调用。
- 重叠根不能简单去重：同一文件在父根的 name-only 索引可能需要在子根按更宽松的 `perFolder` 内容设置升级为 full。保留此顺序语义，流式遍历仍消除了全量路径数组。
- 4,000 个临时文件的可重复测量：完整枚举到首个可处理路径为 33.53ms；生成器首次 yield 为 0.28ms。该测量刻意不包含内容提取和向量化。
- 全套测试中的五项既有模块测试无法经 NODE_PATH 解析 ESM 依赖（`pdfjs-dist`、`ai`、`@electron/asar`）；新测试和其 CommonJS 依赖可通过主仓 NODE_PATH 运行。
- 复核后 `listFiles` 仅由本分支测试使用，生产代码无消费者；删除该兼容接口，测试改用 `walkFiles`。
- scheduler 的自动目标索引和 Solo 流程均跨多个 await；通过 IPC 的 `withStore` 包裹整个回调，释放由其 finally 统一处理，而 `tick` 继续立即返回扫描结果。
