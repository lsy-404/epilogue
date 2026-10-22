# Findings

- Release signing is centralized in `scripts/release-signing.mjs`; `release.yml` source jobs submit three lanes and upload request-context JSON as `source-*`; `release-publish.yml` downloads those records plus Linux packages and performs final publish.
- GitEdge recipes require direct source layouts. The workflows now upload macOS `unsigned.tar.gz`, `template.dmg`, `source.json` at root and Windows `app/`, `source.json` at root, without a nested ZIP.
- GitEdge source artifact sizes refer to the full GitHub artifact ZIP. The helper hashes the downloaded ZIP and checks the exact REST `size_in_bytes` before requesting a signature.
- The request context artifacts retain `source-*` names so the publisher's existing cross-run artifact selection keeps downloading request records and Linux packages while excluding native signing payloads.
- The publisher verifies the native request source digest/size against the saved request context; output download headers and complete archive bytes against the native output digest/size; and each extracted release file against `verification.json`. macOS final-stage `input_digest` may refer to its prior stage output; Windows remains single-stage and is required to match the original source digest.
- Source profiles are `epilogue-macos-arm64`, `epilogue-windows-x64`, `epilogue-windows-arm64`; direct input artifact names are the matching profile with `-source` suffix.
- Searches across SynthV and Stardust workspaces found no signing migration prototype to reuse.
- Full test initially lacked installed `@electron/asar`; locked dependency installation resolved the environment issue. Full `pnpm test` then passed 101 tests; the added native contract tests and packaging workflow assertions passed separately.
