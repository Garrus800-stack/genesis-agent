// ============================================================
// GENESIS UI — modules/chat.js
// Chat messages, streaming, markdown rendering, send/stop.
// ============================================================

// v7.7.0: i18n re-added — needed for not-ready toast in sendMessage.
const { t } = require('./i18n');
const { isAgentReady } = require('./agent-state');
const { showToast } = require('./statusbar');

const $ = (sel) => document.querySelector(sel);

let isStreaming = false;
let streamingMessageEl = null;

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// FIX v4.12.3 (S-01): Escape HTML BEFORE markdown transforms to prevent XSS.
// Previously, raw LLM output was passed directly through regex transforms and
// injected via innerHTML — allowing <script> or <img onerror=...> execution.
//
// FIX v4.12.7 (Audit-08): NOTE: Regex markdown is fragile with nested backticks
// and edge cases. Consider migrating to marked.js (~7KB min) or markdown-it for
// robustness: npm install marked; const { marked } = require('marked');
function renderMarkdown(text) {
  if (!text) return '';
  // 0. Plan-Cards (ZIP 15a Basics): extract <plan>…</plan> blocks
  //    BEFORE anything else. Format:
  //      <plan title="Build the report">
  //      - Step 1
  //      - Step 2
  //      </plan>
  //    Title attribute is optional, defaults to "Plan". Steps are
  //    lines starting with "- ". Empty lines and other content
  //    inside the block are ignored. The resulting placeholder is
  //    restored to a <div class="plan-card">…</div> at the end.
  const planBlocks = [];
  let safe = text.replace(
    /<plan(?:\s+title="([^"]*)")?\s*>\n?([\s\S]*?)<\/plan>/gi,
    (_m, title, body) => {
      const steps = body.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
        .map(l => l.slice(2).trim())
        .filter(Boolean);
      const idx = planBlocks.length;
      planBlocks.push({ title: title || 'Plan', steps });
      return `\x00PLANBLOCK_${idx}\x00`;
    }
  );
  // 1. Extract code blocks BEFORE escaping (they get their own escaping).
  // v7.5.9 ZIP4 Phase 11: capture lang too — needed to detect mermaid
  // blocks downstream and route them to the diagram renderer instead
  // of a plain <pre>.
  const codeBlocks = [];
  safe = safe.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: (lang || '').toLowerCase(), code: escapeHtml(code), raw: code });
    return `\x00CODEBLOCK_${idx}\x00`;
  });
  const inlineCode = [];
  safe = safe.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = inlineCode.length;
    inlineCode.push(escapeHtml(code));
    return `\x00INLINE_${idx}\x00`;
  });
  // 2. Escape all remaining HTML entities
  safe = escapeHtml(safe);
  // 3. Apply markdown transforms on safe text
  safe = safe
    // v7.7.0 (A8): heading transforms. Order matters — process ### first
    // so it's not eaten by ## or # patterns. Mapping (offset by 1 from
    // markdown level): # → h2, ## → h3, ### → h4. Same as legacy
    // renderer.js Z.134-136. Reserves h1 for page-level semantic.
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
  // 4. Restore code blocks (already escaped).
  // v7.5.9 ZIP4 Phase 11: mermaid blocks get a special wrapper so the
  // attachCodeButtons hook can hydrate them into rendered SVG. The raw
  // (unescaped) source is preserved as a data attribute and re-encoded
  // safely via JSON-stringify-then-escape to avoid attribute-injection.
  safe = safe.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, i) => {
    const block = codeBlocks[+i];
    if (block.lang === 'mermaid') {
      // Explicit attribute escape: escapeHtml uses textContent→innerHTML
      // which doesn't encode quotes — they break HTML attributes. We
      // need the full 5-char escape chain when embedding in data-*="".
      const dataSrc = JSON.stringify(block.raw)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const id = 'merm-' + Math.random().toString(36).slice(2, 10);
      return `<div class="mermaid-block-wrapper" data-mermaid-id="${id}" data-mermaid-src="${dataSrc}">` +
        `<div class="mermaid-block-toolbar">` +
          `<button class="mermaid-toggle-btn" data-id="${id}" data-mode="diagram">📋 Code</button>` +
        `</div>` +
        `<div class="mermaid-diagram" id="${id}">` +
          `<div class="mermaid-loading">[Diagramm wird geladen…]</div>` +
        `</div>` +
        `<pre class="mermaid-code" id="${id}-code" style="display:none"><code>${block.code}</code></pre>` +
      `</div>`;
    }
    return `<pre class="code-block"><code>${block.code}</code></pre>`;
  });
  safe = safe.replace(/\x00INLINE_(\d+)\x00/g, (_m, i) =>
    `<code>${inlineCode[+i]}</code>`);
  // Restore plan-blocks as Plan-Cards (15a Basics: render-only, no
  // interactivity yet — that lands in 15b/15c).
  safe = safe.replace(/\x00PLANBLOCK_(\d+)\x00/g, (_m, i) => {
    const p = planBlocks[+i];
    if (!p || p.steps.length === 0) return '';
    const stepsHtml = p.steps.map((s, n) =>
      `<li class="plan-card-step">` +
        `<span class="plan-card-step-num">${n + 1}</span>` +
        `<span class="plan-card-step-text">${escapeHtml(s)}</span>` +
      `</li>`
    ).join('');
    const countLabel = p.steps.length === 1 ? '1 Schritt' : `${p.steps.length} Schritte`;
    return `<div class="plan-card" data-plan-steps="${p.steps.length}">` +
      `<div class="plan-card-header">` +
        `<span class="plan-card-icon">📋</span>` +
        `<span class="plan-card-title">${escapeHtml(p.title)}</span>` +
        `<span class="plan-card-count">${countLabel}</span>` +
      `</div>` +
      `<ol class="plan-card-steps">${stepsHtml}</ol>` +
    `</div>`;
  });
  return safe;
}

function renderMarkdownWithEditorButtons(text) {
  let html = renderMarkdown(text);
  html = html.replace(/<pre class="code-block"><code>([\s\S]*?)<\/code><\/pre>/g, (match, code) => {
    const id = 'code-' + Math.random().toString(36).slice(2, 8);
    return `<div class="code-wrapper">
      <div class="code-actions">
        <button class="code-btn" data-action="copy" data-target="${id}" title="Copy">📋</button>
        <button class="code-btn" data-action="edit" data-target="${id}" title="Open in editor">✏️</button>
        <button class="code-btn" data-action="run" data-target="${id}" title="Run in sandbox">▶</button>
      </div>
      <pre class="code-block" id="${id}"><code>${code}</code></pre>
    </div>`;
  });
  return html;
}

function addMessage(role, content, intent, meta = {}) {
  const container = $('#chat-messages');
  const msg = document.createElement('div');
  // FIX v5.1.0: Align class names with styles.css — was chat-message/msg-icon/msg-body
  // v7.7.9 Phase 2: self-initiated messages get an extra class so styles.css
  // can render the small dot-marker; tooltip names the kind, score, and
  // a short reference so the user can tell at-a-glance why Genesis spoke up.
  let classes = `message ${role}-message`;
  let titleAttr = '';
  if (meta && meta.initiatedBy === 'self') {
    classes += ' self-initiated';
    const sm = meta.selfMeta || {};
    const kind = sm.kind || '?';
    const score = typeof sm.score === 'number' ? sm.score.toFixed(2) : '?';
    let ref = '';
    if (sm.sourceRef && typeof sm.sourceRef === 'object') {
      const r = sm.sourceRef;
      if (r.goalDescription) ref = ` · ref: ${String(r.goalDescription).slice(0, 60)}`;
      else if (r.goalId)     ref = ` · ref: ${r.goalId}`;
      else if (r.activity)   ref = ` · ref: ${r.activity}`;
    }
    const tip = `Genesis von sich aus · kind: ${kind} · score: ${score}${ref}`;
    titleAttr = ` title="${escapeHtml(tip)}"`;
  }
  msg.className = classes;
  const icon = role === 'user' ? '▸' : 'G';
  const name = role === 'user' ? 'You' : 'Genesis';
  const intentTag = intent && intent !== 'general' && intent !== 'stream' && intent !== 'error'
    ? `<span class="intent-tag">${escapeHtml(intent)}</span>` : '';
  msg.innerHTML = `<div class="message-icon"${titleAttr}>${icon}</div>
    <div class="message-content">
      <div class="message-name"${titleAttr}>${name} ${intentTag}</div>
      ${renderMarkdownWithEditorButtons(content)}
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  attachCodeButtons(msg);
  return msg;
}

function attachCodeButtons(messageEl) {
  for (const btn of messageEl.querySelectorAll('.code-btn')) {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const code = target.textContent;
      const action = btn.dataset.action;
      if (action === 'copy') {
        navigator.clipboard.writeText(code).catch(e => console.debug('[UI] Clipboard copy failed:', e.message));
      } else if (action === 'edit') {
        // v6.0.2: Open directly in editor panel (no IPC needed — editor is in same process)
        const editorPanel = document.getElementById('editor-panel');
        if (editorPanel && editorPanel.classList.contains('hidden')) {
          editorPanel.classList.remove('hidden');
        }
        try {
          const { setEditorContent } = require('./editor');
          setEditorContent(code, 'javascript');
        } catch (_e) {
          // Fallback: copy to clipboard
          navigator.clipboard.writeText(code).catch(() => {});
        }
      } else if (action === 'run') {
        window.genesis.invoke('agent:run-in-sandbox', code).then(result => {
          const output = result?.output || result?.error || JSON.stringify(result);
          addMessage('agent', '```\n' + output + '\n```', 'sandbox');
        }).catch(err => addMessage('agent', '❌ ' + err.message, 'error'));
      }
    });
  }

  // v7.5.9 ZIP4 Phase 11 — Mermaid hydration + Code/Diagramm toggle.
  for (const wrapper of messageEl.querySelectorAll('.mermaid-block-wrapper')) {
    if (wrapper.dataset.hydrated === '1') continue;
    wrapper.dataset.hydrated = '1';
    _hydrateMermaid(wrapper);
    const btn = wrapper.querySelector('.mermaid-toggle-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const diagram = wrapper.querySelector('#' + id);
        const codePre = wrapper.querySelector('#' + id + '-code');
        if (!diagram || !codePre) return;
        const showingDiagram = btn.dataset.mode === 'diagram';
        if (showingDiagram) {
          diagram.style.display = 'none';
          codePre.style.display = '';
          btn.textContent = '📊 Diagramm';
          btn.dataset.mode = 'code';
        } else {
          diagram.style.display = '';
          codePre.style.display = 'none';
          btn.textContent = '📋 Code';
          btn.dataset.mode = 'diagram';
        }
      });
    }
  }
}

// ── v7.5.9 ZIP4 + ZIP6 + ZIP7 — Mermaid loader ────────────────
// Mermaid is loaded by a static <script> tag in index.bundled.html,
// pointing at dist/mermaid.min.js. By the time the renderer module
// executes, window.mermaid should already be initialized. If for
// any reason the static script failed to load (file missing, file://
// origin quirks), we fall back to the CDN as a last resort.
let _mermaidLib = null;
let _mermaidLoading = null;
function _ensureMermaid() {
  if (_mermaidLib) return Promise.resolve(_mermaidLib);
  if (_mermaidLoading) return _mermaidLoading;
  _mermaidLoading = new Promise((resolve, reject) => {
    if (window.mermaid && typeof window.mermaid.initialize === 'function') {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose',
          fontFamily: 'inherit',
          fontSize: 14,
          // useMaxWidth=true → SVG fits container width = overview.
          // The wrapper exposes a 🔍 Zoom button that switches to
          // natural-size for detail. nodeSpacing/rankSpacing keep
          // the layout readable when fitted.
          flowchart: {
            useMaxWidth: true,
            htmlLabels: true,
            nodeSpacing: 50,
            rankSpacing: 60,
            padding: 12,
          },
          sequence: { useMaxWidth: true },
          gantt: { useMaxWidth: true },
        });
        _mermaidLib = window.mermaid;
        return resolve(_mermaidLib);
      } catch (err) {
        return reject(new Error(`Mermaid initialize failed: ${err.message}`));
      }
    }
    reject(new Error('window.mermaid nicht verfügbar — dist/mermaid.min.js fehlt oder konnte nicht geladen werden'));
  });
  return _mermaidLoading;
}

async function _hydrateMermaid(wrapper) {
  const diagramEl = wrapper.querySelector('.mermaid-diagram');
  if (!diagramEl) return;
  const dataSrc = wrapper.dataset.mermaidSrc;
  if (!dataSrc) return;
  let rawSource;
  try {
    rawSource = JSON.parse(dataSrc);
  } catch (e) {
    diagramEl.innerHTML = `<div class="mermaid-error">[Diagramm-Quelle konnte nicht dekodiert werden]</div>`;
    return;
  }

  const TIMEOUT_LOAD = 3000;
  const TIMEOUT_RENDER = 6000;
  const tmpId = 'mermaid-svg-' + Math.random().toString(36).slice(2, 10);
  const tmp = document.createElement('div');
  tmp.id = tmpId + '-host';
  tmp.style.cssText = 'position:absolute;left:-9999px;top:0;width:1200px;visibility:hidden;';

  try {
    let loadTimer;
    const loadTimeoutP = new Promise((_, reject) => {
      loadTimer = setTimeout(() => reject(new Error(`Load Timeout (${TIMEOUT_LOAD}ms) — window.mermaid nicht verfügbar`)), TIMEOUT_LOAD);
    });
    let mermaid;
    try {
      mermaid = await Promise.race([_ensureMermaid(), loadTimeoutP]);
    } finally {
      clearTimeout(loadTimer);
    }

    if (typeof mermaid.parse === 'function') {
      try {
        await mermaid.parse(rawSource);
      } catch (parseErr) {
        throw new Error(`Mermaid-Syntax-Fehler: ${parseErr.message || parseErr}`);
      }
    }

    document.body.appendChild(tmp);
    let renderTimer;
    const renderTimeoutP = new Promise((_, reject) => {
      renderTimer = setTimeout(() => reject(new Error(`Render Timeout (${TIMEOUT_RENDER}ms)`)), TIMEOUT_RENDER);
    });
    let renderResult;
    try {
      renderResult = await Promise.race([
        mermaid.render(tmpId, rawSource, tmp),
        renderTimeoutP,
      ]);
    } finally {
      clearTimeout(renderTimer);
    }
    const svg = renderResult && renderResult.svg ? renderResult.svg : '';
    if (!svg) throw new Error('Mermaid lieferte leeres SVG');
    diagramEl.innerHTML = svg;
  } catch (err) {
    const msg = (err && err.message) ? err.message : 'unknown error';
    diagramEl.innerHTML = `<div class="mermaid-error">[Diagramm-Render fehlgeschlagen: ${escapeHtml(msg)}]</div>` +
      `<pre class="mermaid-fallback-source">${escapeHtml(rawSource)}</pre>`;
  } finally {
    if (tmp.parentNode) tmp.remove();
  }
}

function startStreamingMessage() {
  isStreaming = true;
  $('#btn-send').classList.add('hidden');
  $('#btn-stop').classList.remove('hidden');
  // v5.1.0: Create message element directly — don't pass HTML through markdown renderer
  const container = $('#chat-messages');
  const msg = document.createElement('div');
  msg.className = 'message agent-message';
  msg.innerHTML = `<div class="message-icon">G</div>
    <div class="message-content">
      <div class="message-name">Genesis</div>
      <div class="typing-indicator"><span></span><span></span><span></span></div>
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  msg._chunks = [];
  streamingMessageEl = msg;
  return streamingMessageEl;
}

function appendToStream(chunk) {
  if (!streamingMessageEl) return;
  streamingMessageEl._chunks.push(chunk);
  const full = streamingMessageEl._chunks.join('');
  const body = streamingMessageEl.querySelector('.message-content');
  if (body) body.innerHTML = `<div class="message-name">Genesis</div>${renderMarkdownWithEditorButtons(full)}`;
  const container = $('#chat-messages');
  container.scrollTop = container.scrollHeight;
}

function finishStream() {
  isStreaming = false;
  $('#btn-send').classList.remove('hidden');
  $('#btn-stop').classList.add('hidden');
  if (streamingMessageEl) {
    attachCodeButtons(streamingMessageEl);
    streamingMessageEl = null;
  }
}

async function sendMessage() {
  const input = $('#chat-input');
  const msg = input.value.trim();
  if (!msg || isStreaming) return;
  // v7.7.0: not-ready guard. Without this, user input typed during the
  // boot window (~1-3s between DOMContentLoaded and agent:ready) was
  // silently dropped — the IPC send would fire but the backend wasn't
  // listening yet, so the message vanished. Legacy renderer.js had the
  // equivalent guard via Genesis.UI.boot.ready.
  if (!isAgentReady()) {
    showToast(t('ui.still_starting'), 'warning');
    return;
  }
  input.value = '';
  input.style.height = 'auto';
  addMessage('user', escapeHtml(msg));
  startStreamingMessage();
  window.genesis.send('agent:request-stream', msg);
}

function stopGeneration() {
  window.genesis.invoke('agent:chat:stop').catch(e => console.warn('[UI] Chat stop failed:', e.message));
  finishStream();
}

function getStreamingState() { return { isStreaming, streamingMessageEl }; }

// v7.7.2: extracted from settings.js — auto-resize the chat textarea
// to fit its content, capped at 150px. Wired in renderer-main.js
// to the input event of #chat-input.
function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
}

module.exports = {
  addMessage, startStreamingMessage, appendToStream, finishStream,
  sendMessage, stopGeneration, escapeHtml, renderMarkdown,
  getStreamingState, attachCodeButtons,
  // v7.7.2:
  autoResize,
};
