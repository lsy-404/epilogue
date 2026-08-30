'use strict';

const path = require('path');
const { fileURLToPath } = require('url');

function normalizedFilePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Only the packaged renderer entry (optionally with a hash route) may replace the
// main page. This rejects http(s), data, javascript and arbitrary local files.
function isTrustedRendererNavigation(targetUrl, rendererEntry) {
  try {
    const target = new URL(targetUrl);
    if (target.protocol !== 'file:' || target.search) return false;
    return normalizedFilePath(fileURLToPath(target)) === normalizedFilePath(rendererEntry);
  } catch {
    return false;
  }
}

// An IPC message must come from the live main window's top-level frame. Checking
// both WebContents and WebFrameMain prevents a compromised child frame (if one is
// ever introduced) from reaching filesystem and credential handlers.
function isTrustedIpcEvent(event, getWindow) {
  const window = getWindow?.();
  if (!window || window.isDestroyed?.()) return false;
  const contents = window.webContents;
  if (!contents || contents.isDestroyed?.()) return false;
  return event?.sender === contents && event?.senderFrame === contents.mainFrame;
}

module.exports = { isTrustedRendererNavigation, isTrustedIpcEvent };
