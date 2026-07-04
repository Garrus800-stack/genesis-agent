// ============================================================
// GENESIS — core/shell/shell-fence-extract.js (v7.9.28)
//
// Pull READ-ONLY shell commands out of fenced code blocks.
//
// Some models write `cat X` / `find …` / `ls` inside a ```bash block instead
// of emitting a tool call, so nothing runs and they loop ("file not found"
// while the file exists). The chat tool-loop uses this to recover: it runs
// ONLY the commands that isReadOnlyShellCommand approves — cat/type/ls/dir/
// find/grep/head/tail/git-status/etc. Anything that writes, deletes, installs,
// or executes is left untouched (shown as a code block, never auto-run).
// ============================================================

const { isReadOnlyShellCommand } = require('./ShellReadVocabulary');

const FENCE_RE = /```(?:bash|sh|shell|zsh|console|terminal|cmd|powershell|pwsh|ps1?|dos|bat)?\s*\r?\n([\s\S]*?)```/gi;

/**
 * @param {string} text - model output that may contain fenced shell blocks
 * @param {number} [max=5] - cap on how many commands to return
 * @returns {string[]} read-only shell commands, in order
 */
function extractReadOnlyShellCommands(text, max = 5) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const re = new RegExp(FENCE_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null && out.length < max) {
    for (const rawLine of String(m[1]).split(/\r?\n/)) {
      // strip a leading shell prompt ("$ ", "> ", "PS…> ") and whitespace
      const line = rawLine.replace(/^\s*(?:\$|#|>|PS[^>]*>)\s+/, '').trim();
      if (!line || line.startsWith('#')) continue;
      try { if (isReadOnlyShellCommand(line)) out.push(line); } catch (_e) { /* skip */ }
      if (out.length >= max) break;
    }
  }
  return out;
}

module.exports = { extractReadOnlyShellCommands };
