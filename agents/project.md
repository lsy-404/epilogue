# Epilogue 项目索引
> 最后更新：2026-09-05

## 项目目标

Epilogue 是用于理解、整理和检索本地文件的 Electron 应用。

## 技术栈

- Electron 主进程（CommonJS）负责设置、推理、OAuth 与 IPC。
- 原生 HTML/CSS/JavaScript 渲染器通过 preload 桥接主进程。
- Provider Source 目录数据来自 models.dev。

## 模块结构

- `src/main/settings.js`：持久化的应用与 provider 设置。
- `src/main/ipc.js`：渲染器到主进程的接口。
- `src/main/llm.js`、`src/main/providerAdapters.js`：实际推理与协议适配。
- `src/main/providerOAuth.js`：OAuth 凭据与刷新。
- `src/renderer/`：设置与交互界面。

## 性能与驻留架构

- 元数据采用gzip JSON，向量采用EVB1二进制文件，查询使用固定大小块缓冲且不常驻向量。
- 索引库筛选在主进程执行，通过IPC返回最多400条可见行；渲染器打开寻物后才查询。
- 异步库操作通过使用计数保护，托盘无活跃使用者时释放元数据；模型子进程在托盘空闲5秒后回收。
- 性能回归、基准与隔离Electron冒烟均位于根/test。
- 开发工作流与任务操作依据见[本地指令](local.instructions.md)。
