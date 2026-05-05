// ============================================================
// GENESIS — test/modules/v759-zip5-plancards.test.js
//
// v7.5.9 ZIP 15a — Plan-Cards Basics. Tests:
//  1. renderMarkdown extracts and renders <plan>…</plan> blocks
//  2. Title attribute is preserved (with HTML-escape)
//  3. Steps starting with "- " are extracted
//  4. Empty plan blocks render nothing (no skeleton card)
//  5. Plan blocks coexist with code blocks and inline code
//  6. PromptBuilder formatting section mentions <plan> blocks
//  7. CSS has .plan-card style
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const { describe, test, assert, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

// Extract the renderMarkdown function from chat.js source. The chat.js
// module is browser-side (escapeHtml uses document.createElement), so
// we provide a pure-JS escapeHtml stub here and only inject the
// renderMarkdown body. The behavior we test is the plan-block
// extraction and HTML scaffolding — both string-only operations.
function loadRenderMarkdown() {
  const chatSrc = fs.readFileSync(
    path.join(ROOT, 'src/ui/modules/chat.js'),
    'utf8'
  );
  const renderMatch = chatSrc.match(/function\s+renderMarkdown\s*\([\s\S]*?\n\}\n/);
  assert(renderMatch, 'could not extract renderMarkdown from chat.js');
  // Pure-JS escapeHtml stub matching the production semantics:
  // encodes & < > but NOT " ' (matches document.textContent→innerHTML).
  const stub = `
    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  `;
  // eslint-disable-next-line no-new-func
  return new Function(
    `${stub}\n${renderMatch[0]}\nreturn renderMarkdown;`
  )();
}

describe('v7.5.9 ZIP 15a — Plan-Card extraction', () => {
  test('basic plan-block renders as plan-card div', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '<plan title="Build the report">\n- Step 1\n- Step 2\n- Step 3\n</plan>';
    const out = renderMarkdown(input);
    assert(/class="plan-card"/.test(out), 'must render .plan-card div');
    assert(/Build the report/.test(out), 'title must appear');
    assert(/3 Schritte/.test(out), 'step count "3 Schritte" must appear');
  });

  test('step text is HTML-escaped', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '<plan>\n- Step with <script>alert(1)</script>\n</plan>';
    const out = renderMarkdown(input);
    assert(!/<script>alert/.test(out), 'raw <script> must be escaped');
    assert(/&lt;script&gt;/.test(out), 'expected escaped form');
  });

  test('title is HTML-escaped', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '<plan title="A &amp; B">\n- One\n</plan>';
    const out = renderMarkdown(input);
    // The title attribute came in already with &amp;; renderMarkdown
    // re-escapes via escapeHtml which preserves entity safety.
    assert(/A.*B/.test(out), 'title text must remain readable');
    assert(!/onerror=/i.test(out), 'must not allow attribute injection');
  });

  test('missing title defaults to "Plan"', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '<plan>\n- One\n- Two\n</plan>';
    const out = renderMarkdown(input);
    assert(/plan-card-title">Plan</.test(out), 'default title "Plan"');
    assert(/2 Schritte/.test(out), '2 steps counted');
  });

  test('singular step uses "1 Schritt"', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '<plan>\n- Only one step\n</plan>';
    const out = renderMarkdown(input);
    assert(/1 Schritt</.test(out), 'singular form "1 Schritt"');
    assert(!/1 Schritte/.test(out), 'must not use plural for one');
  });

  test('empty plan-block renders nothing', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '<plan title="Empty"></plan>';
    const out = renderMarkdown(input);
    assert(!/plan-card/.test(out), 'empty plan must not produce a card');
  });

  test('non-step lines inside plan are ignored', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = [
      '<plan>',
      'Some intro text',
      '- Real step one',
      '',
      'More prose',
      '- Real step two',
      '</plan>',
    ].join('\n');
    const out = renderMarkdown(input);
    assert(/Real step one/.test(out), 'first step must appear');
    assert(/Real step two/.test(out), 'second step must appear');
    assert(/2 Schritte/.test(out), 'only 2 steps counted (prose ignored)');
    assert(!/Some intro text/.test(out), 'prose lines must not render');
  });

  test('plan-block and code-block coexist', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = [
      'Hier der Plan:',
      '<plan title="Test">',
      '- Run npm install',
      '- Run npm test',
      '</plan>',
      '',
      'Beispiel-Code:',
      '```javascript',
      'console.log("hi")',
      '```',
    ].join('\n');
    const out = renderMarkdown(input);
    assert(/plan-card/.test(out), 'plan card present');
    assert(/code-block/.test(out), 'code block present');
    assert(/Run npm install/.test(out), 'plan step text present');
    assert(/console\.log/.test(out), 'code body present (escaped or raw)');
  });

  test('multiple plan-blocks in one message', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = [
      '<plan title="First">\n- A\n- B\n</plan>',
      '<plan title="Second">\n- X\n- Y\n- Z\n</plan>',
    ].join('\n\n');
    const out = renderMarkdown(input);
    const cardCount = (out.match(/class="plan-card"/g) || []).length;
    assert(cardCount === 2, `expected 2 plan-cards, got ${cardCount}`);
    assert(/First/.test(out) && /Second/.test(out), 'both titles present');
  });

  test('renderMarkdown unaffected when no plan-block present', () => {
    const renderMarkdown = loadRenderMarkdown();
    const input = '**Hello** world\n- Item 1\n- Item 2';
    const out = renderMarkdown(input);
    assert(/<strong>Hello<\/strong>/.test(out), 'bold markdown still works');
    assert(!/plan-card/.test(out), 'no plan-card for plain markdown');
  });
});

describe('v7.5.9 ZIP 15a — PromptBuilder mentions plan-blocks', () => {
  test('formatting section instructs the LLM to use <plan> blocks', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/intelligence/PromptBuilderSections.js'),
      'utf8'
    );
    assert(/<plan/.test(src), 'PromptBuilderSections must mention <plan>');
    assert(/Plan-Card|plan-card|mehrstufige/i.test(src),
      'must reference Plan-Card concept');
  });
});

describe('v7.5.9 ZIP 15a — CSS has plan-card styles', () => {
  test('styles.css defines .plan-card', () => {
    const css = fs.readFileSync(
      path.join(ROOT, 'src/ui/styles.css'),
      'utf8'
    );
    assert(/\.plan-card\s*\{/.test(css), '.plan-card rule missing');
    assert(/\.plan-card-header/.test(css), '.plan-card-header rule missing');
    assert(/\.plan-card-step/.test(css), '.plan-card-step rule missing');
  });
});

run();
