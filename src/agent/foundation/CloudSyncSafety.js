// ============================================================
// GENESIS — CloudSyncSafety
//
// Shared cloud-sync-path awareness. Extracted in v7.8.3 from
// SelfModelSourceRead.js (which had its own private copy since
// v7.5.8) so other entry points — SkillManager, PluginRegistry,
// HotReloader, AgentCoreBoot — can use the same detection and
// the same defensive read-timeout.
//
// Why this matters: cloud-sync clients (OneDrive Files-On-Demand,
// iCloud Drive, Dropbox Smart Sync, Google Drive File Stream) mark
// files as "placeholders" — `fs.existsSync` returns true but a
// `fs.readFileSync` triggers an implicit network download. On a
// slow connection or first-touch boot, this hangs the caller for
// 30s+. Skill discovery, plugin scan, and file-watch all sit in
// the boot path; one cloud-only file there freezes Genesis at
// startup.
//
// Markers cover (v7.8.3 additions: Mac iCloud canonical path,
// Linux/Mac Dropbox slash-form):
//   - OneDrive: Windows `\OneDrive\…`, `\OneDrive - Personal\…`,
//                Mac/Linux `/OneDrive/…`, `/OneDrive - …/…`
//   - iCloud:   Windows `\iCloudDrive\…`, Mac symlink `/iCloudDrive/…`,
//                Mac canonical `/Library/Mobile Documents/com~apple~CloudDocs/…`
//   - Dropbox:  Windows `\Dropbox\…`, Mac/Linux `/Dropbox/…`
//   - Google Drive: Windows `\Google Drive\…`,
//                    Mac/Linux `/Google Drive/…`, `/GoogleDrive/…`
//
// Detection is conservative: a path is considered cloud-synced
// only if a marker appears with proper path-separator context.
// Substring matches like `OneDriveBackup` do not trigger.
// ============================================================

'use strict';

const fsp = require('fs').promises;

const CLOUD_SYNC_PATH_MARKERS = [
  /\\OneDrive(\s-\s[^\\/]+)?\\/i,    // Windows OneDrive (+ business variants)
  /\/OneDrive(\s-\s[^/]+)?\//i,      // Mac/Linux OneDrive

  /\\iCloudDrive\\/i,                // Windows iCloud
  /\/iCloudDrive\//i,                // Mac iCloud symlink (v7.8.3)
  /\/Library\/Mobile Documents\/com~apple~CloudDocs\//i,  // Mac canonical (v7.8.3)

  /\\Dropbox\\/i,                    // Windows Dropbox
  /\/Dropbox\//i,                    // Mac/Linux Dropbox (v7.8.3)

  /\\Google\s+Drive\\/i,             // Windows Google Drive
  /\/Google\s+Drive\//i,             // Mac/Linux Google Drive
  /\/GoogleDrive\//i,                // Alt no-space form (v7.8.3)
];

const DEFAULT_READ_TIMEOUT_MS = 1500;

/**
 * Detect whether a path lives under a cloud-sync root that may
 * deliver Files-On-Demand placeholders.
 * @param {string} fullPath
 * @returns {boolean}
 */
function isCloudSyncPath(fullPath) {
  if (typeof fullPath !== 'string' || !fullPath) return false;
  return CLOUD_SYNC_PATH_MARKERS.some((re) => re.test(fullPath));
}

/**
 * Read a file asynchronously with a hard timeout. Use for callers
 * that cannot tolerate the 30s+ hang of cloud-placeholder downloads.
 *
 * Rejects with err.code === 'CLOUD_PLACEHOLDER_TIMEOUT' on timeout
 * so callers can distinguish from normal I/O errors.
 *
 * @param {string} fullPath
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<string>}
 */
function readFileWithTimeout(fullPath, timeoutMs = DEFAULT_READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`Read timeout (${timeoutMs}ms) — likely cloud-sync placeholder: ${fullPath}`);
      err.code = 'CLOUD_PLACEHOLDER_TIMEOUT';
      reject(err);
    }, timeoutMs);
    fsp.readFile(fullPath, 'utf-8').then(
      (content) => { if (!settled) { settled = true; clearTimeout(timer); resolve(content); } },
      (err)     => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } }
    );
  });
}

/**
 * Safe-read a file from a boot-path location. Behaviour:
 *   - Non-cloud path: synchronous `fs.readFileSync` (fast, no overhead).
 *   - Cloud-sync path: log warning, fall back to async timeout-wrapper
 *     and AWAIT it. Caller must be async-context to use the result;
 *     if called from a sync caller, that caller decides what to do
 *     (skip the file, queue for later, etc).
 *
 * Returns null on read failure of any kind. Boot-path callers can
 * then choose to skip-and-continue rather than crash.
 *
 * @param {string} fullPath
 * @param {{ logger?: object, timeoutMs?: number }} [opts]
 * @returns {Promise<string|null>}
 */
async function safeReadFileForBoot(fullPath, opts = {}) {
  const { logger, timeoutMs = DEFAULT_READ_TIMEOUT_MS } = opts;
  try {
    if (isCloudSyncPath(fullPath)) {
      if (logger?.warn) {
        logger.warn(`[CLOUD-SYNC] Cloud-backed read may hang: ${fullPath} — using ${timeoutMs}ms timeout`);
      }
      return await readFileWithTimeout(fullPath, timeoutMs);
    }
    // Fast path: local file, just read synchronously and return
    return require('fs').readFileSync(fullPath, 'utf-8');
  } catch (err) {
    if (logger?.warn) {
      logger.warn(`[CLOUD-SYNC] Read failed: ${fullPath} — ${err.message}`);
    }
    return null;
  }
}

module.exports = {
  isCloudSyncPath,
  readFileWithTimeout,
  safeReadFileForBoot,
  CLOUD_SYNC_PATH_MARKERS,
  DEFAULT_READ_TIMEOUT_MS,
};
