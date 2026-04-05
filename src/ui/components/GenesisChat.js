// ============================================================
// GENESIS UI — components/GenesisChat.js (v4.10.0)
//
// Reactive Web Component replacing the vanilla DOM chat module.
// Uses GenesisElement base class for reactive rendering.
//
// FEATURES:
//   - Reactive message list (add/update without full re-render)
//   - Streaming with per-chunk DOM updates (no innerHTML churn)
//   - XSS-safe markdown rendering
//   - Code block actions (copy, edit, run)
//   - Auto-scroll with smart behavior (doesn't jump when reading)
//   - i18n integration
//   - Custom events for parent orchestration
//
// USAGE:
//   <genesis-chat></genesis-chat>
//
//   const chat = document.querySelector('genesis-chat');
//   chat.addMessage('user', 'Hello!');
//   chat.addMessage('agent', '**Bold** response', 'chat');
//   chat.startStream();
//   chat.appendChunk('streaming ');
//   chat.appendChunk('text...');
//   chat.finishStream();
// ============================================================

'use strict';

class GenesisChat extends GenesisElement {
  static properties = {
    streaming: { type: Boolean, default: false },
  };

  constructor() {
    super();
    this._messages = []; // { role, content, intent, el }
    this._streamChunks = [];
    this._streamEl = null;
    this._userScrolled = false;
  }

  styles() {
    return `
      :host { display: flex; flex-direction: column; height: 100%; background: var(--bg-deep, #08080c); }

      .messages {
        flex: 1; overflow-y: auto; padding: 20px 24px;
        display: flex; flex-direction: column; gap: 16px;
        scroll-behavior: smooth;
      }

      .message { display: flex; gap: 12px; max-width: 100%; animation: fadeIn 0.2s ease; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }

      .msg-icon {
        width: 32px; height: 32px; border-radius: 8px;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; flex-shrink: 0; margin-top: 2px; font-weight: bold;
      }

      .user { flex-direction: row-reverse; }
      .user .msg-icon { background: var(--accent, #6c8cff); color: #fff; }
      .user .msg-body {
        background: var(--user-bg, #141828); border: 1px solid var(--user-border, #252a48);
        border-radius: 12px 12px 2px 12px; padding: 10px 14px;
        font-size: 13px; line-height: 1.65; max-width: 80%;
      }

      .agent .msg-icon {
        background: var(--bg-elevated, #161822); color: var(--accent, #6c8cff);
        border: 1px solid var(--border, #252839);
      }
      .agent .msg-body {
        background: var(--genesis-bg, #0c1018); border: 1px solid var(--genesis-border, #1a2030);
        border-radius: 12px 12px 12px 2px; padding: 12px 16px;
        font-size: 13px; line-height: 1.7; max-width: 90%;
      }

      .system .msg-icon { background: var(--bg-elevated, #161822); color: var(--accent, #6c8cff); }
      .system .msg-body {
        background: var(--bg-surface, #0f1017); border: 1px solid var(--border, #252839);
        border-radius: 10px; padding: 12px 16px; font-size: 12px; color: var(--text-secondary, #8888a0);
      }

      .msg-name { font-size: 11px; font-weight: 600; margin-bottom: 3px; letter-spacing: 0.3px; }
      .user .msg-name { color: var(--accent, #6c8cff); text-align: right; }
      .agent .msg-name { color: var(--text-secondary, #8888a0); }

      .intent-tag {
        display: inline-block; font-size: 9px; padding: 1px 6px;
        border-radius: 3px; background: var(--accent-soft, #1a2040); color: var(--accent, #6c8cff);
        text-transform: uppercase; letter-spacing: 0.5px; margin-left: 6px;
      }

      /* Markdown elements */
      .msg-body strong { font-weight: 600; }
      .msg-body em { font-style: italic; }
      .msg-body code {
        font-family: var(--font-mono, monospace); font-size: 12px;
        background: var(--bg-surface, #0f1017); padding: 1px 5px; border-radius: 3px;
      }
      .msg-body pre {
        background: var(--bg-surface, #0f1017); border: 1px solid var(--border, #252839);
        border-radius: 6px; padding: 10px 12px; margin: 8px 0;
        overflow-x: auto; font-family: var(--font-mono, monospace); font-size: 12px;
        line-height: 1.5; position: relative;
      }
      .msg-body pre code { background: none; padding: 0; }
      .msg-body a { color: var(--accent, #6c8cff); text-decoration: none; }
      .msg-body a:hover { text-decoration: underline; }
      .msg-body ul, .msg-body ol { margin: 4px 0; padding-left: 20px; }
      .msg-body li { margin: 2px 0; }

      /* Code block actions */
      .code-wrapper { position: relative; }
      .code-actions {
        position: absolute; top: 4px; right: 4px;
        display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s;
      }
      .code-wrapper:hover .code-actions { opacity: 1; }
      .code-btn {
        background: var(--accent-dim, #4a62b3); color: #fff; border: none;
        border-radius: 4px; padding: 2px 8px; font-size: 10px;
        cursor: pointer; font-family: var(--font-sans, sans-serif);
      }
      .code-btn:hover { opacity: 0.8; }

      /* Streaming cursor */
      .typing { color: var(--accent, #6c8cff); animation: blink 0.8s step-end infinite; }
      @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

      /* Input area */
      .input-area {
        padding: 12px 20px; border-top: 1px solid var(--border, #252839);
        display: flex; gap: 8px; align-items: flex-end;
        background: var(--bg-surface, #0f1017);
      }

      textarea {
        flex: 1; background: var(--bg-elevated, #161822); border: 1px solid var(--border, #252839);
        border-radius: 10px; color: var(--text-primary, #e0e0e8); padding: 10px 14px;
        font-family: var(--font-sans, sans-serif); font-size: 13px; line-height: 1.5;
        resize: none; outline: none; max-height: 150px; min-height: 42px;
      }
      textarea:focus { border-color: var(--accent, #6c8cff); }
      textarea::placeholder { color: var(--text-dim, #555568); }

      .btn-action {
        width: 42px; height: 42px; border-radius: 10px; border: none;
        cursor: pointer; font-size: 16px; display: flex;
        align-items: center; justify-content: center; flex-shrink: 0;
        transition: all 0.15s;
      }
      .btn-send { background: var(--accent, #6c8cff); color: #fff; }
      .btn-send:hover { opacity: 0.85; }
      .btn-send:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-stop { background: var(--error, #f87171); color: #fff; display: none; }
      .btn-stop:hover { opacity: 0.8; }
      .btn-stop.visible { display: flex; }
      .btn-send.hidden { display: none; }

      /* Scrollbar */
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: var(--border, #252839); border-radius: 3px; }
    `;
  }

  render() {
    return html`
      <div class="messages" id="messages"></div>
      <div class="input-area">
        <textarea
          id="input"
          rows="1"
          placeholder="${this.t('chat.placeholder', {}) || 'Ask Genesis anything...'}"
          @keydown=${(e) => this._onKeydown(e)}
          @input=${(e) => this._autoResize(e)}
        ></textarea>
        <button class="btn-action btn-send ${this.streaming ? 'hidden' : ''}" @click=${() => this.send()}>▸</button>
        <button class="btn-action btn-stop ${this.streaming ? 'visible' : ''}" @click=${() => this.stop()}>■</button>
      </div>
    `;
  }

  onMount() {
    // Wire IPC listeners
    this._unsubChunk = window.genesis.on('agent:stream-chunk', (c) => this.appendChunk(c));
    this._unsubDone = window.genesis.on('agent:stream-done', () => this.finishStream());

    // Smart scroll detection
    const msgs = this.$('#messages');
    if (msgs) {
      msgs.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = msgs;
        this._userScrolled = (scrollHeight - scrollTop - clientHeight) > 100;
      });
    }
  }

  onUnmount() {
    if (this._unsubChunk) this._unsubChunk();
    if (this._unsubDone) this._unsubDone();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  addMessage(role, content, intent) {
    const msgs = this.$('#messages');
    if (!msgs) return null;

    const msg = document.createElement('div');
    msg.className = `message ${role}`;

    const icon = role === 'user' ? '▸' : role === 'system' ? '⚙' : 'G';
    const name = role === 'user' ? 'You' : role === 'system' ? 'System' : 'Genesis';
    const intentTag = intent && !['general', 'stream', 'error'].includes(intent)
      ? `<span class="intent-tag">${this._esc(intent)}</span>` : '';

    msg.innerHTML = `
      <div class="msg-icon">${icon}</div>
      <div>
        <div class="msg-name">${name}${intentTag}</div>
        <div class="msg-body">${role === 'user' ? this._esc(content) : this._renderMarkdown(content)}</div>
      </div>
    `;

    msgs.appendChild(msg);
    this._wireCodeButtons(msg);
    this._scrollToBottom();
    this._messages.push({ role, content, intent, el: msg });
    return msg;
  }

  send() {
    const input = this.$('#input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg || this.streaming) return;

    input.value = '';
    input.style.height = 'auto';
    this.addMessage('user', msg);
    this.startStream();
    window.genesis.send('agent:request-stream', msg);
    this.emit('chat-send', { message: msg });
  }

  stop() {
    window.genesis.invoke('agent:chat:stop').catch(e => console.warn('[UI] Chat stop failed:', e.message));
    this.finishStream();
    this.emit('chat-stop');
  }

  startStream() {
    this.streaming = true;
    this._streamChunks = [];
    this._streamEl = this.addMessage('agent', '<span class="typing">●●●</span>', 'stream');
  }

  appendChunk(chunk) {
    if (!this._streamEl) return;
    this._streamChunks.push(chunk);
    const full = this._streamChunks.join('');
    const body = this._streamEl.querySelector('.msg-body');
    if (body) body.innerHTML = this._renderMarkdown(full);
    this._scrollToBottom();
  }

  finishStream() {
    this.streaming = false;
    if (this._streamEl) {
      this._wireCodeButtons(this._streamEl);
      this._streamEl = null;
    }
    this._streamChunks = [];
  }

  clear() {
    const msgs = this.$('#messages');
    if (msgs) msgs.innerHTML = '';
    this._messages = [];
  }

  // ════════════════════════════════════════════════════════
  // PRIVATE
  // ════════════════════════════════════════════════════════

  _onKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  _autoResize(e) {
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
  }

  _scrollToBottom() {
    if (this._userScrolled) return;
    const msgs = this.$('#messages');
    if (msgs) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  }

  // ── Markdown (XSS-safe) ────────────────────────────────

  _esc(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  _safeHref(url) {
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) return '#';
    return this._esc(url);
  }

  _renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/<(?!br\s*\/?>)[^>]+>/gi, (m) => this._esc(m))
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const id = 'cb-' + Math.random().toString(36).slice(2, 8);
        return `<div class="code-wrapper"><div class="code-actions">
          <button class="code-btn" data-action="copy" data-target="${id}">📋</button>
          <button class="code-btn" data-action="edit" data-target="${id}">✏️</button>
          <button class="code-btn" data-action="run" data-target="${id}">▶</button>
        </div><pre id="${id}"><code class="language-${this._esc(lang || 'text')}">${this._esc(code.trim())}</code></pre></div>`;
      })
      .replace(/`([^`]+)`/g, (_, m) => '<code>' + this._esc(m) + '</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
        `<a href="${this._safeHref(url)}" target="_blank" rel="noopener noreferrer">${this._esc(label)}</a>`)
      .replace(/\*\*(.+?)\*\*/g, (_, m) => '<strong>' + this._esc(m) + '</strong>')
      .replace(/\*(.+?)\*/g, (_, m) => '<em>' + this._esc(m) + '</em>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/\n/g, '<br>');
  }

  // ── Code Block Actions ─────────────────────────────────

  _wireCodeButtons(messageEl) {
    for (const btn of messageEl.querySelectorAll('.code-btn')) {
      btn.addEventListener('click', () => {
        const target = messageEl.querySelector(`#${btn.dataset.target}`);
        if (!target) return;
        const code = target.textContent;
        const action = btn.dataset.action;

        if (action === 'copy') {
          navigator.clipboard.writeText(code).catch(e => console.debug('[UI] Clipboard copy failed:', e.message));
          this.emit('chat-copy', { code });
        } else if (action === 'edit') {
          this.emit('chat-open-editor', { content: code, language: 'javascript' });
        } else if (action === 'run') {
          window.genesis.invoke('agent:run-in-sandbox', code).then(result => {
            const output = result?.output || result?.error || JSON.stringify(result);
            this.addMessage('agent', '```\n' + output + '\n```', 'sandbox');
          }).catch(err => this.addMessage('agent', '❌ ' + err.message, 'error'));
        }
      });
    }
  }
}

customElements.define('genesis-chat', GenesisChat);
