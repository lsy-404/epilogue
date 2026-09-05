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
