'use strict';
/**
 * PathExtractVocab — ONE shared path-extraction vocabulary (v7.9.28, G4/F3/F7).
 *
 * A single home for path extraction so there is no second pattern drifting
 * alongside the openPath one (7.9.24 anti-drift). openPath's own winPath stays
 * the whitespace-stop /([A-Za-z]:\\[^\s"']*)/ (v758); spaced paths go through the
 * quoted branch. WIN_DRIVE_PATH_RE here is the EOL-tolerant InstallDetect pattern,
 * used ONLY by InstallDetect + F7 (scopedSearch), where the path sits at the end
 * of the message.
 */

// EOL-tolerant: captures a drive path up to end-of-line or a 2+ space gap.
const WIN_DRIVE_PATH_RE = /\b([A-Za-z]:[\\/][^\r\n]*?)(?:\s*$|\s{2,})/;

/** Strip surrounding quotes + trailing sentence punctuation from a path. */
function cleanPath(p) {
  if (!p) return p;
  let s = String(p).trim();
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  s = s.replace(/[.,;:!?]+$/, '');
  return s.trim();
}

// Keyword that introduces a path/target ("in", "im Ordner", "unter", "from", ...).
const KW = '(?:in|im|unter|aus|auf|from|inside|under|at)';
// Quoted target after a keyword: keyword "<...>"
const KW_QUOTED_RE = new RegExp(KW + '\\s+["\u201c\u201e\u00ab\']([^"\u201d\u00bb\']+)["\u201d\u00bb\']', 'i');
// Drive path after a keyword (EOL-tolerant).
const KW_WIN_RE = new RegExp(KW + '\\s+([A-Za-z]:[\\\\/][^\\r\\n]*?)(?:\\s*$|\\s{2,})', 'i');

/**
 * Extract a path that follows a location keyword. Quote-aware (a quoted target
 * wins and keeps spaces) and token-stopping for bare drive paths.
 * Returns the cleaned path or null.
 */
function extractPathAfterKeyword(message) {
  if (!message) return null;
  const q = message.match(KW_QUOTED_RE);
  if (q && q[1]) return cleanPath(q[1]);
  const w = message.match(KW_WIN_RE);
  if (w && w[1]) return cleanPath(w[1]);
  // Bare drive path anywhere (EOL-tolerant), last resort.
  const d = message.match(WIN_DRIVE_PATH_RE);
  if (d && d[1]) return cleanPath(d[1]);
  return null;
}

module.exports = { WIN_DRIVE_PATH_RE, cleanPath, extractPathAfterKeyword };
