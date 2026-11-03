# Epilogue

<img src="logo.svg" width="96" align="right" />

**files, remembered.** An AI file workflow desktop app (macOS / Windows / Linux).

English | [中文](README.md)

Open source (**ALE 1.1 & GPL-3.0**) with **zero data collection** — settings, index and vectors never leave your machine.

[**Download releases →**](https://github.com/wuyilingwei/epilogue/releases) (macOS arm64; Windows / Linux on x64 and arm64)

## Features

- **Cleanup**: periodically scans for files left untouched for too long; AI suggests where each one belongs based on your filing habits written in plain language, and moves them after your item-by-item confirmation. It recognizes sets (lecture series, portable apps, episodes) and files them as a whole, making use of nested destination folder structures. Successful moves are recorded in a local transaction journal and can be undone across restarts.
- **Recall**: "Where did I put last term's lab report?" — find any file in one sentence, via keyword / similarity / AI Q&A modes; understands relative time like "last year" or "last week".
- **Quick search**: press `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS) from any app, or open Quick search from the tray. Search indexed filenames, summaries, and keywords locally without calling AI. Use arrow keys to select, Enter to open, Shift+Enter to reveal in the file manager, and Esc or click outside to close. Add files or folders in Recall first. Change or disable the shortcut and check its registration status in Settings → App. The tray entry remains available if another app owns the shortcut.
- **Assistant**: a built-in conversational agent with an Observe → Plan → Act → Verify loop for file lookup, status inspection, and configuration. Read operations can run automatically; every settings write is previewed and requires explicit approval.
- **Optional automation** (off by default, can only be enabled manually): Solo mode auto-files on schedule without per-item approval; optionally let the AI move clearly worthless temp files to the system Trash.

## AI Capabilities

Each capability uses one enabled provider (per-row enable, one-click connectivity test):

| Capability | Built-in presets | Notes |
| --- | --- | --- |
| Chat | No preinstalled cloud provider | use Add to choose from the models.dev / OpenCode Provider Source catalog or connect official Claude / ChatGPT Codex OAuth |
| Text embeddings | **On-device BGE** (offline) | or use a cloud API |

Understands archives, Office documents, PDFs and plain text; other files (images, audio/video, etc.) are indexed by file name and metadata.

Choose a protocol for each custom Chat provider in Settings. Its base URL should point to the matching API root (usually ending in `/v1`). One protocol boundary now handles model discovery, native tool calls, usage parsing, and error isolation. Provider body overrides cannot replace managed message, tool, or model fields.

The UI uses the Fluent design tokens of `@platform-kit/fluent` (Apache-2.0) from [lsy-404/platform-kit](https://github.com/lsy-404/platform-kit), with an Electron product layer for GPU-composited Acrylic surfaces, responsive layout, unified flyout menus, agent-stage feedback, and write-approval cards.

Add opens the models.dev / OpenCode Provider Source catalog for click-to-connect setup, alongside official Claude and ChatGPT Codex browser OAuth. OAuth uses PKCE and keeps access/refresh tokens in Electron `safeStorage`, outside settings JSON and the renderer. Custom Compatible endpoints still support API-key rotation, request overlays, and manual JSON field mapping.

## Run & Develop

```bash
corepack pnpm@10.34.6 install --frozen-lockfile
pnpm start      # launch the app
pnpm test       # unit tests
bash scripts/pack.sh [platform] [arch]   # local packaging
```

Tests cover all three Chat protocol adapters, model discovery, safe body merging, agent boundaries, reversible file moves, and streaming vector storage.

Pushing a stable `vX.Y.Z` tag builds source packages for each platform and submits macOS arm64 and Windows x64/arm64 to the signing center; it does not create a public release. Once all source builds succeed and the signing requests finish, the center automatically dispatches **Publish signed release**. To recover a publication, you can also run it manually in GitHub Actions with the source run's ID. The publisher creates the release only after the center verifies all signed outputs, then attaches the signed installers, Linux packages, checksums, and attestations. Signed outputs are removed 24 hours after success, so run the publisher promptly. macOS Intel remains excluded because the local-model runtime no longer ships Darwin x64 binaries.

## Privacy & License

- No telemetry, no analytics, no phone-home; all data stays on your machine and can be inspected and cleaned in-app.
- When you use AI features, relevant file content is sent to **the providers you configure (or the built-in defaults)**, governed by their own privacy policies; avoid AI features on highly sensitive files.
- License: **ALE 1.1 (Anti-Labor Exploitation License, prevailing) & GPL-3.0** — GPL rights are conditional on ALE compliance; ALE's restrictions apply primarily to commercial and employing entities. Full terms and license texts are bundled in-app (Settings → About).

### Pinned model-auth dependencies

`@model-auth/core`, `@model-auth/providers`, and `@model-auth/vue` use independently versioned Platform Kit release packages. `pnpm-lock.yaml` pins their download URLs and SHA-512 integrity checks. Run `node test/public-model-auth.test.mjs` to verify installed versions, licenses, imports, and lockfile entries.
