'use strict';
// v7.9.22 Part 1 grounding helpers, shared by _stepAnalyze and _stepCode so neither
// duplicates the logic and AgentLoopSteps.js stays under the file-size guard.
//   - sourceForPrompt(content, budget): send a module in full under a generous budget,
//     marking an over-budget cut explicitly so a cut is never read as the file's end (G1).
//   - checkSyntaxForPrompt(verifier, target, content): run the real parser over a JS
//     module before the model speaks and return its verdict as a prompt line plus a
//     verified syntaxOk fact, treating a missing parser or a non-JS target as
//     unverifiable — never as confirmed-OK and never as confirmed-broken (G3a/G3b).

// acorn parses plain JS/CommonJS/ESM; a .jsx/.ts target is treated as non-JS (unverifiable)
// rather than forced through a parser that would report a false failure.
const JS_EXT = /\.(c|m)?js$/i;

function sourceForPrompt(content, budget) {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= budget) return text;
  const cut = text.length - budget;
  return text.slice(0, budget) + `\n\n... [truncated: ${cut} more characters not shown]`;
}

// Returns { line, syntaxOk }:
//   line     — a prompt line stating the verdict, or '' when nothing can be said.
//   syntaxOk — true on a clean parse, false on a parse error, null when unverifiable
//              (no verifier, non-JS target, empty content, or the parser is absent).
function checkSyntaxForPrompt(verifier, target, content) {
  const unverifiable = { line: '', syntaxOk: null };
  if (!verifier || typeof verifier.checkSyntax !== 'function') return unverifiable;
  if (!target || !JS_EXT.test(String(target))) return unverifiable;
  if (typeof content !== 'string' || content.length === 0) return unverifiable;

  let result;
  try {
    result = verifier.checkSyntax(content);
  } catch (_e) {
    return unverifiable;
  }
  if (!result) return unverifiable;
  // A skip note means the parser is absent — could not verify, not confirmed-OK.
  if (result.note) return { line: 'Syntax check (acorn): skipped — could not verify.', syntaxOk: null };
  if (result.passed === true) return { line: 'Syntax check (acorn): PASS.', syntaxOk: true };
  if (result.passed === false) {
    const where = result.line ? ` at line ${result.line}` : '';
    return { line: `Syntax check (acorn): FAIL${where}.`, syntaxOk: false };
  }
  return unverifiable;
}

module.exports = { sourceForPrompt, checkSyntaxForPrompt };
