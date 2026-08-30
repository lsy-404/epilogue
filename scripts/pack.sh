#!/bin/bash
# Epilogue 打包脚本：依赖裁剪 + 平台图标 + 语言包裁剪（保 en/zh）
# 用法: bash scripts/pack.sh [darwin|win32|linux] [arm64|x64]   （默认 darwin arm64）
set -euo pipefail
cd "$(dirname "$0")/.."

PLATFORM="${1:-darwin}"
ARCH="${2:-arm64}"
OUT="dist/Epilogue-$PLATFORM-$ARCH"

# 使用 afterPrune 实体删除非目标 ONNX 二进制，并在 ASAR 生成后再次验证。
# 任一目标运行库缺失或归档仍含其它平台/架构时，Node 脚本会非零退出。
node scripts/package-app.mjs "$PLATFORM" "$ARCH"

# 语言包裁剪：仅保留 en* / zh*
if [ "$PLATFORM" = "darwin" ]; then
  RES="$OUT/Epilogue.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"
  find "$RES" -maxdepth 1 -name '*.lproj' ! -name 'en*' ! -name 'zh*' -exec rm -rf {} +
else
  # win/linux：Chromium locales/*.pak
  find "$OUT/locales" -maxdepth 1 -name '*.pak' ! -name 'en-US*' ! -name 'zh-CN*' ! -name 'zh-TW*' -delete
fi

du -sh "$OUT"
