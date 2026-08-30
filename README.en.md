# Epilogue

<img src="logo.svg" width="96" align="right" />

**files, remembered.** An AI file workflow desktop app (macOS / Windows / Linux).

English | [中文](README.md)

Open source (**ALE 1.1 & GPL-3.0**) with **zero data collection** — settings, index and vectors never leave your machine; audio/video transcription runs on-device by default.

[**Download releases →**](https://github.com/wuyilingwei/epilogue/releases) (macOS arm64; Windows / Linux on x64 and arm64)

## Features

- **Cleanup**: periodically scans for files left untouched for too long; AI suggests where each one belongs based on your filing habits written in plain language, and moves them after your item-by-item confirmation. It recognizes sets (lecture series, portable apps, episodes) and files them as a whole, making use of nested destination folder structures.
- **Recall**: "Where did I put last term's lab report?" — find any file in one sentence, via keyword / similarity / AI Q&A modes; find images by text description; understands relative time like "last year" or "last week".
- **Assistant**: a built-in conversational agent with an Observe → Plan → Act → Verify loop for file lookup, status inspection, and configuration. Read operations can run automatically; every settings write is previewed and requires explicit approval.
- **Optional automation** (off by default, can only be enabled manually): Solo mode auto-files on schedule without per-item approval; optionally let the AI move clearly worthless temp files to the system Trash.

## AI Capabilities & Multi-Provider Failover

Every capability is a **failover list** (drag to reorder, per-row enable, one-click connectivity test), tried top-down:

| Capability | Built-in presets | Notes |
| --- | --- | --- |
| Chat | No preinstalled cloud provider | use Add to choose from the models.dev / OpenCode Provider Source catalog or connect official Claude / ChatGPT Codex OAuth |
| Text embeddings | **On-device BGE** (offline) | cloud APIs as fallback |
| Image embeddings | **On-device CLIP family, 4 options** (downloaded on demand) | find images with descriptions like "red poster" |
| Whisper / transcription | **On-device, two quality tiers** (downloaded independently) | cloud transcription as fallback |

Understands archives, Office documents, PDFs, plain text, images, and audio/video.

Choose a protocol for each custom Chat provider in Settings. Its base URL should point to the matching API root (usually ending in `/v1`). One protocol boundary now handles model discovery, native tool calls, usage parsing, and error isolation. Provider body overrides cannot replace managed message, tool, or model fields.

The UI uses WinUI design tokens from [Furry-Xiyi/WinUIonWeb](https://github.com/Furry-Xiyi/WinUIonWeb), with an Electron product layer for GPU-composited Acrylic surfaces, responsive layout, unified flyout menus, agent-stage feedback, and write-approval cards. See `src/renderer/vendor/winui/NOTICE.md` for attribution.

Add opens the models.dev / OpenCode Provider Source catalog for click-to-connect setup, alongside official Claude and ChatGPT Codex browser OAuth. OAuth uses PKCE and keeps access/refresh tokens in Electron `safeStorage`, outside settings JSON and the renderer. Custom Compatible endpoints still support API-key rotation, request overlays, and manual JSON field mapping.

## Lightweight Residency

Heavily optimized for low footprint: the tray-resident app uses almost no resources, UI and data load only when needed, heavy work automatically yields to your foreground tasks, and everything slows down on battery. No Dock icon while tray-resident (macOS).

## Run & Develop

```bash
npm install
npm start      # launch the app
npm test       # unit tests
bash scripts/pack.sh [platform] [arch]   # local packaging
```

Tests cover request/response conversion for all three Chat protocols, model discovery, safe body merging, plus the agent tool allowlist and settings-write boundary.

Pushing a `v*` tag triggers CI for every supported release target. macOS Intel is temporarily excluded because the current local-model runtime no longer ships Darwin x64 binaries; this avoids publishing an installable package with broken local models.

## Privacy & License

- No telemetry, no analytics, no phone-home; all data stays on your machine and can be inspected and cleaned in-app.
- When you use AI features, relevant file content is sent to **the providers you configure (or the built-in defaults)**, governed by their own privacy policies; avoid AI features on highly sensitive files.
- License: **ALE 1.1 (Anti-Labor Exploitation License, prevailing) & GPL-3.0** — GPL rights are conditional on ALE compliance; ALE's restrictions apply primarily to commercial and employing entities. Full terms and license texts are bundled in-app (Settings → About).
