// ============================================================
// GENESIS UI — modules/chat.js
// Chat messages, streaming, markdown rendering, send/stop.
// ============================================================

// i18n: t() not currently used — re-add when chat messages are localized

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
  // 1. Extract code blocks BEFORE escaping (they get their own escaping)
  const codeBlocks = [];
  let safe = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(escapeHtml(code));
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
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
  // 4. Restore code blocks (already escaped)
  safe = safe.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, i) =>
    `<pre class="code-block"><code>${codeBlocks[+i]}</code></pre>`);
  safe = safe.replace(/\x00INLINE_(\d+)\x00/g, (_m, i) =>
    `<code>${inlineCode[+i]}</code>`);
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

function addMessage(role, content, intent) {
  const container = $('#chat-messages');
  const msg = document.createElement('div');
  // FIX v5.1.0: Align class names with styles.css — was chat-message/msg-icon/msg-body
  msg.className = `message ${role}-message`;
  const icon = role === 'user' ? '▸' : 'G';
  const name = role === 'user' ? 'You' : 'Genesis';
  const intentTag = intent && intent !== 'general' && intent !== 'stream' && intent !== 'error'
    ? `<span class="intent-tag">${escapeHtml(intent)}</span>` : '';
  msg.innerHTML = `<div class="message-icon">${icon}</div>
    <div class="message-content">
      <div class="message-name">${name} ${intentTag}</div>
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

module.exports = {
  addMessage, startStreamingMessage, appendToStream, finishStream,
  sendMessage, stopGeneration, escapeHtml, renderMarkdown,
  getStreamingState, attachCodeButtons,
};
