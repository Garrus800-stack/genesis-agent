// ============================================================
// GENESIS AGENT — renderer.js (v4.0.0 — Modular Architecture)
//
// v4.0.0 REFACTOR: Monolith broken into named modules under
// a Genesis.UI namespace. Each module owns its DOM, state, and
// event wiring. No external dependencies beyond window.genesis
// (preload API) and Monaco (lazy-loaded CDN).
//
// Module map:
//   Genesis.UI.i18n       — Internationalization
//   Genesis.UI.toast      — Toast notification stack
//   Genesis.UI.status     — Status badge in topbar
//   Genesis.UI.monaco     — Monaco editor integration
//   Genesis.UI.files      — File tree panel
//   Genesis.UI.chat       — Chat messages + streaming
//   Genesis.UI.markdown   — Markdown → HTML (XSS-safe)
//   Genesis.UI.settings   — Settings modal
//   Genesis.UI.goals      — Goal tree panel
//   Genesis.UI.models     — Model selector
//   Genesis.UI.health     — Health & Self-Model display
//   Genesis.UI.undo       — Revert last change
//   Genesis.UI.dragdrop   — File drag & drop
//   Genesis.UI.boot       — Boot sequence + welcome
//
// Globals: $, $$, togglePanel (used by onclick in HTML)
// ============================================================

'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function togglePanel(id) {
  const panel = document.getElementById(id);
  if (panel) panel.classList.toggle('hidden');
  if (id === 'editor-panel') $('#btn-toggle-editor')?.classList.toggle('active');
  if (id === 'file-tree-panel') $('#btn-toggle-tree')?.classList.toggle('active');
  if (Genesis.UI.monaco.editor) setTimeout(() => Genesis.UI.monaco.editor.layout(), 50);
}

const Genesis = { UI: {} };

// ── i18n ───────────────────────────────────────────────────
Genesis.UI.i18n = (() => {
  let strings = {};
  function t(key, vars = {}) {
    let str = strings[key] || key;
    for (const [k, v] of Object.entries(vars)) str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
    return str;
  }
  function apply() {
    $$('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'), v = t(k); if (v !== k) el.textContent = v; });
    $$('[data-i18n-placeholder]').forEach(el => { const k = el.getAttribute('data-i18n-placeholder'), v = t(k); if (v !== k) el.placeholder = v; });
  }
  async function load() {
    try { strings = await window.genesis.invoke('agent:get-lang-strings'); apply(); if (strings._lang) { const s = $('#lang-select'); if (s) s.value = strings._lang; } }
    catch (err) { console.debug('[i18n] Load:', err.message); }
  }
  return { t, apply, load };
})();
const t = Genesis.UI.i18n.t;

// ── toast ──────────────────────────────────────────────────
Genesis.UI.toast = (() => {
  function show(message, type = 'info') {
    const c = $('#toast-container'), el = document.createElement('div');
    el.className = 'toast toast-' + type; el.textContent = message; c.appendChild(el);
    while (c.children.length > 5) c.removeChild(c.firstChild);
    setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 200); }, 3000);
  }
  return { show };
})();

// ── status ─────────────────────────────────────────────────
Genesis.UI.status = (() => {
  function update(status) {
    const b = $('#status-badge'); b.className = 'badge';
    if (status.state === 'ready') { b.classList.add('badge-ready'); b.textContent = status.model || t('ui.ready'); }
    else if (['thinking','self-modifying','self-repairing','creating-skill','cloning'].includes(status.state)) { b.classList.add('badge-working'); b.textContent = status.detail || status.state; }
    else if (status.state === 'error') { b.classList.add('badge-error'); b.textContent = status.detail || t('ui.error'); }
    else if (status.state === 'warning') { b.classList.add('badge-error'); b.textContent = status.detail || 'Warning'; Genesis.UI.toast.show(status.detail || 'Warning', 'warning'); }
    else { b.classList.add('badge-booting'); b.textContent = status.detail || t('ui.starting'); }
  }
  return { update };
})();

// ── markdown ───────────────────────────────────────────────
Genesis.UI.markdown = (() => {
  function esc(text) { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; }
  // FIX v4.10.0 (M-6): Sanitize link URLs — block javascript: and data: schemes
  function safeHref(url) {
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:') || trimmed.startsWith('vbscript:')) return '#';
    return esc(url);
  }
  // FIX v4.10.0 (M-5): Whitelist-based HTML post-sanitization.
  // After the markdown→HTML pipeline completes, strip any tags that are NOT
  // in our known-safe set. This catches edge cases where mixed LLM output
  // (raw HTML interleaved with markdown) could slip through the regex chain.
  // Lightweight alternative to DOMPurify — no external dependency needed.
  //
  // FIX v4.12.7 (Audit-07): NOTE: Regex-based sanitizers have historical bypass
  // issues (mutation XSS, nested tags, encoding tricks). CSP blocks execution,
  // but for defense-in-depth, consider migrating to DOMPurify (~3KB gzipped):
  //   npm install dompurify
  //   import DOMPurify from 'dompurify'; html = DOMPurify.sanitize(html);
  // This would replace _sanitizeHtml entirely.
  const _ALLOWED_TAGS = new Set([
    'br', 'strong', 'em', 'code', 'pre', 'a', 'h2', 'h3', 'h4',
    'span', 'div', 'button', 'ul', 'ol', 'li', 'p',
  ]);
  function _sanitizeHtml(html) {
    return html.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, name) => {
      return _ALLOWED_TAGS.has(name.toLowerCase()) ? tag : esc(tag);
    });
  }
  // v4.12.1 [P2-03]: Shared inline-markdown pipeline — single source of truth
  // for XSS sanitization. render() and renderWithButtons() both delegate here.
  // codeBlockFn receives (lang, trimmedCode, idx) and returns the HTML for
  // fenced code blocks — the only part that differs between the two renderers.
  function _pipeline(text, codeBlockFn) {
    if (!text) return '';
    const state = { idx: 0 };
    const raw = text
      // FIX v4.10.0 (M-6): Strip raw HTML tags from LLM output to prevent injection
      .replace(/<(?!br\s*\/?>)[^>]+>/gi, (m) => esc(m))
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => { state.idx++; return codeBlockFn(l || 'text', c.trim(), state.idx); })
      .replace(/`([^`]+)`/g, (_, m) => '<code>' + esc(m) + '</code>')
      // FIX v4.10.0 (M-6): Support markdown links with sanitized href
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => '<a href="' + safeHref(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>')
      .replace(/\*\*(.+?)\*\*/g, (_, m) => '<strong>' + esc(m) + '</strong>')
      .replace(/\*(.+?)\*/g, (_, m) => '<em>' + esc(m) + '</em>')
      .replace(/^### (.+)$/gm, (_, m) => '<h4>' + esc(m) + '</h4>')
      .replace(/^## (.+)$/gm, (_, m) => '<h3>' + esc(m) + '</h3>')
      .replace(/^# (.+)$/gm, (_, m) => '<h2>' + esc(m) + '</h2>')
      .replace(/\n/g, '<br>');
    return _sanitizeHtml(raw);
  }
  function render(text) {
    return _pipeline(text, (lang, code) =>
      '<pre><code class="language-' + esc(lang) + '">' + esc(code) + '</code></pre>'
    );
  }
  function renderWithButtons(text) {
    return _pipeline(text, (lang, code, idx) => {
      if (code.length < 20) return '<pre><code class="language-' + esc(lang) + '">' + esc(code) + '</code></pre>';
      // FIX v6.1.1: Run button for JS (sandbox) and HTML (browser)
      const isRunnable = ['javascript', 'js', 'node', 'html'].includes(lang.toLowerCase());
      const runLabel = ['html'].includes(lang.toLowerCase()) ? '▶ Open' : '▶ Run';
      const runBtn = isRunnable ? '<button class="code-run-btn" data-lang="' + esc(lang) + '" data-idx="' + idx + '">' + runLabel + '</button>' : '';
      return '<div class="code-block-wrapper">' + runBtn + '<button class="code-to-editor-btn" data-lang="' + esc(lang) + '" data-idx="' + idx + '">' + t('ui.open_in_editor') + '</button><pre><code class="language-' + esc(lang) + '">' + esc(code) + '</code></pre></div>';
    });
  }

  return { render, renderWithButtons, esc };
})();

// ── monaco ─────────────────────────────────────────────────
Genesis.UI.monaco = (() => {
  let editor = null, currentFile = null;
  function init() {
    const local = '../../node_modules/monaco-editor/min/vs';
    // FIX v4.10.0 (L-4): CDN fallback gated behind explicit user action.
    // Previous: silently loaded from cdnjs.cloudflare.com if local node_modules
    // was missing. This is a supply-chain risk (CDN compromise → code injection).
    // Now: show a toast asking the user to install monaco locally. If they
    // explicitly click through, fall back to CDN as last resort.
    const cdn = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs';
    function boot() {
      monaco.editor.defineTheme('genesis-dark', { base: 'vs-dark', inherit: true,
        rules: [{ token: 'comment', foreground: '555568', fontStyle: 'italic' },{ token: 'keyword', foreground: '6c8cff' },{ token: 'string', foreground: '4ade80' },{ token: 'number', foreground: 'fbbf24' }],
        colors: { 'editor.background': '#0f1017', 'editor.foreground': '#e0e0e8', 'editor.lineHighlightBackground': '#161822', 'editorCursor.foreground': '#6c8cff', 'editorLineNumber.foreground': '#333550' },
      });
      editor = monaco.editor.create($('#monaco-container'), { value: '// Genesis\n', language: 'javascript', theme: 'genesis-dark',
        fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',monospace", fontSize: 13, lineHeight: 20, minimap: { enabled: false },
        padding: { top: 10 }, scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, automaticLayout: true, renderLineHighlight: 'line' });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    }
    require.config({ paths: { vs: local } });
    require(['vs/editor/editor.main'], boot, () => {
      // FIX v4.10.0 (L-4): Warn before CDN fallback instead of silently loading external scripts
      console.warn('[MONACO] Local monaco-editor not found. Falling back to CDN.');
      Genesis.UI.toast.show('Editor: local monaco not found — loading from CDN. Run npm install for offline use.', 'warning');
      require.config({ paths: { vs: cdn } });
      require(['vs/editor/editor.main'], boot);
    });
  }
  async function openFile(fp) {
    if (!Genesis.UI.boot.ready) return;
    try {
      const content = await window.genesis.invoke('agent:get-file', fp); if (content === null) return;
      currentFile = fp; $('#editor-filename').textContent = fp;
      if (editor) { const l = fp.endsWith('.json')?'json':fp.endsWith('.html')?'html':fp.endsWith('.css')?'css':fp.endsWith('.md')?'markdown':'javascript'; editor.setModel(monaco.editor.createModel(content, l)); }
      if ($('#editor-panel').classList.contains('hidden')) togglePanel('editor-panel');
    } catch { Genesis.UI.toast.show(t('ui.error'), 'error'); }
  }
  async function save() {
    if (!currentFile||!editor||!Genesis.UI.boot.ready) return;
    try { await window.genesis.invoke('agent:save-file', { filePath: currentFile, content: editor.getValue() }); Genesis.UI.toast.show(t('ui.saved', { file: currentFile }), 'success'); }
    catch (err) { Genesis.UI.toast.show(t('ui.error')+': '+err.message, 'error'); }
  }
  async function runInSandbox() {
    if (!editor||!Genesis.UI.boot.ready) return;
    const code = editor.getModel().getValueInRange(editor.getSelection()) || editor.getValue();
    try { const r = await window.genesis.invoke('agent:run-in-sandbox', code); $('#sandbox-output').classList.remove('hidden'); const el = $('#sandbox-result'); el.className = r.error?'error':''; el.textContent = r.error?`ERROR: ${r.error}\n\n${r.output||''}`:r.output||t('agent.no_output'); }
    catch (err) { console.error('Sandbox:', err); }
  }
  function setModel(content, language, filename) {
    if (!editor||typeof monaco==='undefined') return; editor.setModel(monaco.editor.createModel(content, language||'plaintext'));
    if (filename) { currentFile = filename; $('#editor-filename').textContent = filename; }
  }
  return { init, openFile, save, runInSandbox, setModel, get editor() { return editor; }, get currentFile() { return currentFile; }, set currentFile(f) { currentFile = f; } };
})();

// ── files ──────────────────────────────────────────────────
Genesis.UI.files = (() => {
  async function load() {
    if (!Genesis.UI.boot.ready) return;
    try {
      const files = await window.genesis.invoke('agent:get-file-tree'); const el = $('#file-tree'); el.innerHTML = '';
      for (const f of files) { const item = document.createElement('div'); item.className = 'file-tree-item'+(f.protected?' protected':'');
        item.innerHTML = `<span class="icon">${f.protected?'🔒':f.isModule?'◈':'○'}</span><span>${f.path}</span>`;
        item.addEventListener('click', () => { $$('.file-tree-item').forEach(e => e.classList.remove('active')); item.classList.add('active'); Genesis.UI.monaco.openFile(f.path); });
        el.appendChild(item); }
    } catch (err) { console.error('File tree:', err); }
  }
  return { load };
})();

// ── chat ───────────────────────────────────────────────────
Genesis.UI.chat = (() => {
  let streaming = false, streamEl = null;
  function addMessage(role, content, intent) {
    const c = $('#chat-messages'), msg = document.createElement('div'), md = Genesis.UI.markdown;
    msg.className = 'message '+role+'-message';
    const icon = role==='user'?'▸':'G', name = role==='user'?'You':'Genesis';
    const tag = intent&&intent!=='general'&&intent!=='stream'&&intent!=='error'?'<span class="intent-tag">'+md.esc(intent)+'</span> ':'';
    msg.innerHTML = '<div class="message-icon">'+icon+'</div><div><div class="message-name">'+name+'</div><div class="message-content">'+tag+md.renderWithButtons(content)+'</div></div>';
    c.appendChild(msg); c.scrollTop = c.scrollHeight; _attachBtns(msg); return msg;
  }
  function startStream() {
    const c = $('#chat-messages'), msg = document.createElement('div'); msg.className = 'message agent-message';
    msg.innerHTML = '<div class="message-icon">G</div><div><div class="message-name">Genesis</div><div class="message-content"><span class="streaming-cursor">|</span></div></div>';
    c.appendChild(msg); c.scrollTop = c.scrollHeight; streamEl = msg.querySelector('.message-content');
  }
  function appendChunk(chunk) {
    if (!streamEl) return; const cur = streamEl.querySelector('.streaming-cursor'); if (cur) cur.remove();
    const raw = (streamEl.getAttribute('data-raw')||'')+chunk; streamEl.setAttribute('data-raw', raw);
    streamEl.innerHTML = Genesis.UI.markdown.render(raw)+'<span class="streaming-cursor">|</span>'; $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
  }
  function finishStream() {
    if (!streamEl) return; const raw = streamEl.getAttribute('data-raw')||'';
    streamEl.innerHTML = Genesis.UI.markdown.renderWithButtons(raw); _attachBtns(streamEl.closest('.message'));
    streamEl = null; streaming = false; $('#btn-send').classList.remove('hidden'); $('#btn-stop').classList.add('hidden');
  }
  async function send() {
    const input = $('#chat-input'), msg = input.value.trim(); if (!msg||streaming) return;
    if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
    input.value = ''; input.style.height = 'auto'; addMessage('user', msg);
    streaming = true; $('#btn-send').classList.add('hidden'); $('#btn-stop').classList.remove('hidden');
    startStream(); window.genesis.send('agent:request-stream', msg);
    setTimeout(() => Genesis.UI.i18n.load(), 2000);
  }
  function stop() { window.genesis.invoke('agent:chat:stop'); finishStream(); }
  function _attachBtns(el) {
    if (!el) return;
    el.querySelectorAll('.code-to-editor-btn').forEach(btn => { btn.addEventListener('click', function() {
      const w = this.closest('.code-block-wrapper');
      const cEl = w?.querySelector('code');
      if (!cEl) return;
      const code = cEl.textContent, lang = this.getAttribute('data-lang')||'plaintext';
      if ($('#editor-panel').classList.contains('hidden')) togglePanel('editor-panel');
      const ext = {javascript:'.js',python:'.py',shell:'.sh',bat:'.bat',php:'.php',html:'.html',css:'.css',json:'.json',typescript:'.ts'}[lang]||'.txt';
      Genesis.UI.monaco.setModel(code, lang==='text'?'plaintext':lang, 'genesis_code'+ext);
      Genesis.UI.toast.show(t('ui.code_in_editor', { file: 'genesis_code'+ext }), 'success');
    }); });
    // FIX v6.1.1: Run button — JS → sandbox, HTML → browser
    el.querySelectorAll('.code-run-btn').forEach(btn => { btn.addEventListener('click', async function() {
      const w = this.closest('.code-block-wrapper');
      const cEl = w?.querySelector('code');
      if (!cEl) return;
      const code = cEl.textContent;
      const lang = (this.getAttribute('data-lang') || '').toLowerCase();

      if (lang === 'html') {
        // HTML with UI → save as temp file and open in system browser
        this.textContent = '⏳ Opening...'; this.disabled = true;
        try {
          const tempPath = '~/.genesis/output/_preview_' + Date.now() + '.html';
          await window.genesis.invoke('agent:save-file', { filePath: tempPath, content: code });
          await window.genesis.invoke('agent:open-path', tempPath);
        } catch (err) { Genesis.UI.toast.show('Open failed: ' + err.message, 'error'); }
        this.textContent = '▶ Open'; this.disabled = false;
        return;
      }

      // JS → run in sandbox
      this.textContent = '⏳ Running...'; this.disabled = true;
      try {
        const r = await window.genesis.invoke('agent:run-in-sandbox', code);
        const output = r.error ? 'ERROR: ' + r.error + (r.output ? '\n' + r.output : '') : r.output || '(no output)';
        let outEl = w.querySelector('.code-run-output');
        if (!outEl) { outEl = document.createElement('pre'); outEl.className = 'code-run-output'; w.appendChild(outEl); }
        outEl.textContent = output; outEl.className = 'code-run-output' + (r.error ? ' error' : '');
      } catch (err) { Genesis.UI.toast.show('Sandbox error: ' + err.message, 'error'); }
      this.textContent = '▶ Run'; this.disabled = false;
    }); });
  }
  return { addMessage, appendChunk, finishStream, send, stop };
})();

// ── settings ───────────────────────────────────────────────
Genesis.UI.settings = (() => {
  async function open() {
    if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
    try { const s = await window.genesis.invoke('agent:get-settings');
      $('#set-anthropic-key').value = s.models?.anthropicApiKey||''; $('#set-openai-url').value = s.models?.openaiBaseUrl||''; $('#set-openai-key').value = s.models?.openaiApiKey||'';
      $('#set-daemon').value = String(s.daemon?.enabled!==false); $('#set-idle').value = String(s.idleMind?.enabled!==false); $('#set-selfmod').value = String(s.security?.allowSelfModify!==false);
      $('#settings-modal').classList.remove('hidden');
    } catch { Genesis.UI.toast.show(t('ui.error'), 'error'); }
  }
  function close() { $('#settings-modal').classList.add('hidden'); }
  async function save() {
    try { for (const [k,v] of [['models.anthropicApiKey',$('#set-anthropic-key').value.trim()],['models.openaiBaseUrl',$('#set-openai-url').value.trim()],['models.openaiApiKey',$('#set-openai-key').value.trim()],
      ['daemon.enabled',$('#set-daemon').value==='true'],['idleMind.enabled',$('#set-idle').value==='true'],['security.allowSelfModify',$('#set-selfmod').value==='true']]) {
      if (v!==''&&v!==undefined) await window.genesis.invoke('agent:set-setting', { key: k, value: v }); }
      close(); Genesis.UI.toast.show(t('ui.settings_saved'), 'success');
    } catch (err) { Genesis.UI.toast.show(t('ui.error')+': '+err.message, 'error'); }
  }
  return { open, close, save };
})();
window.closeSettings = () => Genesis.UI.settings.close();

// ── goals ──────────────────────────────────────────────────
Genesis.UI.goals = (() => {
  async function show() {
    if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
    if ($('#goals-panel').classList.contains('hidden')) togglePanel('goals-panel');
    const c = $('#goal-tree');
    try { const tree = await window.genesis.invoke('agent:get-goal-tree');
      if (!tree||tree.length===0) { c.innerHTML = '<div class="goal-empty">'+(t('goals.empty')!=='goals.empty'?t('goals.empty'):'No active goals.')+'</div>'; return; }
      c.innerHTML = ''; for (const r of tree) c.appendChild(_node(r, 0));
    } catch (err) { c.innerHTML = '<div class="goal-empty">'+t('ui.error')+': '+err.message+'</div>'; }
  }
  function _node(g, d) {
    const el = document.createElement('div'); el.className = 'goal-node'; el.style.marginLeft = (d*16)+'px';
    const icons = {active:'▶',completed:'✅',failed:'❌',paused:'⏸',blocked:'🔒',abandoned:'⊘'};
    const pc = g.priority==='high'?'goal-priority-high':g.priority==='low'?'goal-priority-low':'';
    const prog = g.steps?.length>0?`<span class="goal-progress">${g.currentStep||0}/${g.steps.length}</span>`:'';
    const tags = (g.tags||[]).map(tg => `<span class="goal-tag">${md.esc(tg)}</span>`).join('');
    // FIX v4.10.0 (S-3): Escape description, source, and tags to prevent XSS.
    // Previously injected raw g.description and g.source into innerHTML — LLM-generated
    // goals could contain <img onerror=...> or <script> payloads.
    el.innerHTML = `<div class="goal-header ${pc}"><span class="goal-status">${icons[g.status]||'○'}</span><span class="goal-desc">${md.esc(g.description)}</span>${prog}${tags?'<span class="goal-tags">'+tags+'</span>':''}</div><div class="goal-meta"><span class="goal-source">${md.esc(g.source||'self')}</span><span class="goal-date">${new Date(g.created).toLocaleDateString()}</span></div>`;
    if (g.steps?.length>0) { const se = document.createElement('div'); se.className = 'goal-steps'; g.steps.forEach((s,i) => { const sd = document.createElement('div'); sd.className = 'goal-step'+(i<(g.currentStep||0)?' goal-step-done':''); sd.textContent = `${i<(g.currentStep||0)?'✓':'·'} ${s}`; se.appendChild(sd); }); el.appendChild(se); }
    if (g.children?.length>0) for (const ch of g.children) el.appendChild(_node(ch, d+1));
    return el;
  }
  return { show };
})();

// ── models ─────────────────────────────────────────────────
Genesis.UI.models = (() => {
  async function load() {
    const sel = $('#model-select');
    try { const models = await window.genesis.invoke('agent:list-models');
      if (!models||models.length===0) { sel.innerHTML = '<option value="">'+t('ui.no_model')+'</option>'; return; }
      let active = null; try { active = (await window.genesis.invoke('agent:get-health'))?.model?.active; } catch (e) { console.debug('[UI] health fetch skipped:', e.message); }
      sel.innerHTML = ''; for (const m of models) { const o = document.createElement('option'); o.value = m.name; o.textContent = m.name; if (m.name===active) o.selected = true; sel.appendChild(o); }
    } catch { sel.innerHTML = '<option value="">'+t('ui.error')+'</option>'; }
  }
  async function switchTo(name) {
    if (!Genesis.UI.boot.ready||!name) return;
    try { await window.genesis.invoke('agent:switch-model', name); Genesis.UI.toast.show(t('ui.model_switched', { model: name }), 'success'); Genesis.UI.status.update({ state: 'ready', model: name }); }
    catch { Genesis.UI.toast.show(t('ui.switch_failed'), 'error'); }
  }
  return { load, switchTo };
})();

// ── health ─────────────────────────────────────────────────
Genesis.UI.health = (() => {
  async function show() {
    if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
    try { const h = await window.genesis.invoke('agent:get-health'); Genesis.UI.chat.addMessage('agent', [
      '**'+t('health.title')+'**','','**'+t('health.kernel')+':** '+(h.kernel?.ok?t('health.intact'):t('health.problem')),'**'+t('health.model')+':** '+(h.model?.active||t('health.none')),
      '**'+t('health.modules')+':** '+h.modules,'**'+t('health.skills')+':** '+(h.skills?.map(s=>s.name).join(', ')||t('health.none')),'**'+t('health.tools')+':** '+h.tools,
      '**'+t('health.memory')+':** '+(h.memory?.facts||0)+' '+t('health.facts')+', '+(h.memory?.episodes||0)+' '+t('health.episodes'),
      '**'+t('health.daemon')+':** '+(h.daemon?.running?t('ui.active'):t('ui.inactive'))+' ('+(h.daemon?.cycleCount||0)+' '+t('health.cycles')+')',
      '**'+t('health.services')+':** '+(h.services||'?'),'**'+t('health.uptime')+':** '+Math.round(h.uptime||0)+'s'].join('\n'));
    } catch (err) { Genesis.UI.chat.addMessage('agent', t('ui.error')+': '+err.message); }
  }
  async function showSelf() {
    if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
    try { const m = await window.genesis.invoke('agent:get-self-model'); const lines = ['**Genesis — Self-Model**','','**Identity:** '+m.identity+' v'+m.version,
      '**Capabilities:** '+(m.capabilities||[]).join(', '),'**'+t('health.modules')+':** '+Object.keys(m.modules||{}).length,'**Files:** '+Object.keys(m.files||{}).length,'','**Details:**'];
      for (const [f, mod] of Object.entries(m.modules||{})) lines.push('- `'+f+'` — '+mod.classes.join(', ')+' ('+mod.functions.length+' fn)');
      Genesis.UI.chat.addMessage('agent', lines.join('\n'));
    } catch (err) { Genesis.UI.chat.addMessage('agent', t('ui.error')+': '+err.message); }
  }
  return { show, showSelf };
})();

// ── undo ───────────────────────────────────────────────────
Genesis.UI.undo = (() => {
  async function exec() {
    if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
    try { const r = await window.genesis.invoke('agent:undo');
      if (r.ok) { Genesis.UI.toast.show(t('ui.undo_success', { detail: r.reverted||'' }), 'success'); Genesis.UI.chat.addMessage('system', '**Undo:** '+(r.detail||'')); }
      else Genesis.UI.toast.show(r.error||t('ui.undo_nothing'), 'warning');
    } catch (err) { Genesis.UI.toast.show(t('ui.undo_failed', { error: err.message }), 'error'); }
  }
  return { exec };
})();

// ── dragdrop ───────────────────────────────────────────────
Genesis.UI.dragdrop = (() => {
  function setup() {
    const z = document.body;
    z.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); z.classList.add('drag-over'); });
    z.addEventListener('dragleave', () => z.classList.remove('drag-over'));
    z.addEventListener('drop', async (e) => {
      e.preventDefault(); e.stopPropagation(); z.classList.remove('drag-over');
      if (!Genesis.UI.boot.ready) { Genesis.UI.toast.show(t('ui.still_starting'), 'warning'); return; }
      const files = e.dataTransfer?.files; if (!files||files.length===0) return;
      for (const f of files) { const fp = f.path; if (!fp) continue;
        try { const info = await window.genesis.invoke('agent:file-info', fp); if (!info) { Genesis.UI.toast.show(t('ui.error'), 'error'); continue; }
          if (info.canEdit) { const r = await window.genesis.invoke('agent:read-external-file', fp); if (r?.content) { Genesis.UI.monaco.setModel(r.content, r.language||'plaintext', fp); if ($('#editor-panel').classList.contains('hidden')) togglePanel('editor-panel'); Genesis.UI.toast.show(t('ui.file_opened', { file: f.name }), 'success'); } }
          else { const imp = await window.genesis.invoke('agent:import-file', fp); if (imp&&!imp.error) Genesis.UI.toast.show(t('ui.file_imported', { file: f.name }), 'success'); }
        } catch (err) { Genesis.UI.toast.show(t('ui.error')+': '+err.message, 'error'); }
      }
    });
  }
  return { setup };
})();

// ── boot ───────────────────────────────────────────────────
Genesis.UI.boot = (() => {
  let ready = false;
  async function onReady(status) {
    ready = true; console.debug('[UI] Genesis ready'); await Genesis.UI.i18n.load(); Genesis.UI.models.load();
    try {
      // v7.2.4: Filesystem-based first-boot detection (bypasses health data timing issues)
      const bootCheck = await window.genesis.invoke('agent:is-first-boot');
      const isFirst = bootCheck?.firstBoot !== false;
      if (isFirst) { Genesis.UI.chat.addMessage('agent', t('welcome.first')); return; }
      // Not first boot — get greeting data
      const h = await window.genesis.invoke('agent:get-health'), goals = await window.genesis.invoke('agent:get-goals');
      const active = (goals||[]).filter(g => g.status==='active'), facts = h?.memory?.facts||0, thoughts = h?.idleMind?.thoughtCount||0, episodes = h?.memory?.episodes||0, lines = [];
      const u = h?.userName;
      if (u) lines.push(t('welcome.returning', { name: u }));
      else if (episodes<=5) lines.push(t('welcome.returning_anon'));
      else lines.push(t('welcome.returning_familiar'));
      if (active.length>0) { lines.push('','**'+t('welcome.working_on')+'**'); for (const g of active.slice(0,3)) { const p = g.steps?.length>0?` (${g.currentStep||0}/${g.steps.length})`:''; lines.push(`- ${g.description}${p}`); } }
      if (thoughts>0) lines.push('', t('welcome.thoughts', { thoughts, facts }));
      Genesis.UI.chat.addMessage('agent', lines.join('\n'));
    } catch { Genesis.UI.chat.addMessage('agent', "I'm Genesis. Ask me anything."); }
  }
  return { onReady, get ready() { return ready; } };
})();

// ── DOMContentLoaded ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // FIX v4.12.8: Guard against missing preload bridge.
  // On Windows + Electron 33, ESM preload.mjs can fail silently,
  // leaving window.genesis undefined and crashing the entire UI.
  if (!window.genesis) {
    document.body.innerHTML = '<div style="color:#ff6b6b;padding:2em;font-family:monospace;">' +
      '<h2>⚠ Preload bridge failed</h2>' +
      '<p>window.genesis is undefined — the preload script did not load.</p>' +
      '<p>This is a known issue on Windows + Electron 33 with ESM preloads.</p>' +
      '<p><b>Fix:</b> Delete <code>preload.mjs</code> to force CJS fallback, then restart.</p>' +
      '</div>';
    return;
  }
  Genesis.UI.monaco.init(); Genesis.UI.dragdrop.setup();
  const ci = $('#chat-input');
  ci.addEventListener('keydown', (e) => { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); Genesis.UI.chat.send(); } });
  ci.addEventListener('input', () => { ci.style.height = 'auto'; ci.style.height = Math.min(ci.scrollHeight, 150)+'px'; });
  $('#btn-send').addEventListener('click', () => Genesis.UI.chat.send());
  $('#btn-stop').addEventListener('click', () => Genesis.UI.chat.stop());
  $('#btn-toggle-editor').addEventListener('click', () => togglePanel('editor-panel'));
  $('#btn-toggle-tree').addEventListener('click', () => { togglePanel('file-tree-panel'); Genesis.UI.files.load(); });
  // FIX v4.10.0: All onclick="" removed from HTML (CSP blocks inline handlers).
  // Every close/toggle action is now bound via addEventListener.
  $('#btn-close-filetree')?.addEventListener('click', () => togglePanel('file-tree-panel'));
  $('#btn-close-goals')?.addEventListener('click', () => { const p = document.getElementById('goals-panel'); if (p) p.classList.add('hidden'); });
  $('#btn-close-editor')?.addEventListener('click', () => togglePanel('editor-panel'));
  $('#btn-close-sandbox-output')?.addEventListener('click', () => { const p = document.getElementById('sandbox-output'); if (p) p.classList.add('hidden'); });
  $('#btn-close-settings')?.addEventListener('click', () => Genesis.UI.settings.close());
  $('#settings-backdrop')?.addEventListener('click', () => Genesis.UI.settings.close());
  $('#btn-settings-cancel')?.addEventListener('click', () => Genesis.UI.settings.close());
  $('#btn-settings-save')?.addEventListener('click', () => Genesis.UI.settings.save());
  $('#btn-save').addEventListener('click', () => Genesis.UI.monaco.save());
  $('#btn-run-sandbox').addEventListener('click', () => Genesis.UI.monaco.runInSandbox());
  $('#btn-health').addEventListener('click', () => Genesis.UI.health.show());
  $('#btn-self-model').addEventListener('click', () => Genesis.UI.health.showSelf());
  // FIX v4.10.0: Goals button now toggles (open/close) instead of only opening
  $('#btn-goals').addEventListener('click', () => {
    const p = $('#goals-panel');
    if (!p) return;
    if (p.classList.contains('hidden')) { Genesis.UI.goals.show(); }
    else { p.classList.add('hidden'); }
  });
  $('#btn-settings').addEventListener('click', () => Genesis.UI.settings.open());
  $('#btn-undo').addEventListener('click', () => Genesis.UI.undo.exec());
  $('#lang-select').addEventListener('change', async function() { if (!Genesis.UI.boot.ready) return; try { await window.genesis.invoke('agent:set-lang', this.value); await Genesis.UI.i18n.load(); Genesis.UI.toast.show('Language: '+this.value.toUpperCase(), 'success'); } catch (e) { console.debug('[UI] Lang:', e.message); } });
  $('#model-select').addEventListener('change', function() { Genesis.UI.models.switchTo(this.value); });
  document.addEventListener('keydown', (e) => { if (e.ctrlKey&&e.key==='z'&&!e.shiftKey&&document.activeElement?.id!=='chat-input'&&!Genesis.UI.monaco.editor?.hasTextFocus()) { e.preventDefault(); Genesis.UI.undo.exec(); } });

  window.genesis.on('agent:stream-chunk', (c) => Genesis.UI.chat.appendChunk(c));
  window.genesis.on('agent:stream-done', () => Genesis.UI.chat.finishStream());
  window.genesis.on('agent:open-in-editor', (d) => { if (!d?.content) return; if ($('#editor-panel').classList.contains('hidden')) togglePanel('editor-panel'); Genesis.UI.monaco.setModel(d.content, d.language||'plaintext', d.filename||'genesis_output.txt'); Genesis.UI.toast.show(t('ui.code_in_editor', { file: d.filename||'output' }), 'success'); });
  window.genesis.on('agent:status-update', (s) => {
    Genesis.UI.status.update(s);
    if ((s.state==='ready'||s.state==='health-tick')&&!Genesis.UI.boot.ready) Genesis.UI.boot.onReady(s);
    if (s.model&&Genesis.UI.boot.ready) { const sel = $('#model-select'); if (sel&&sel.value!==s.model) { const o = [...sel.options].find(o => o.value===s.model); if (o) sel.value = s.model; else Genesis.UI.models.load(); } }
    if (s.state==='health-tick'&&Genesis.UI.boot.ready) { const sel = $('#model-select'); if (!sel||sel.options.length<=1) Genesis.UI.models.load(); }
  });

  // FIX v4.10.0: Immediate health poll on DOMContentLoaded — don't wait for push.
  // The agent may have booted and sent 'ready' before the renderer loaded.
  // Poll immediately, then retry at increasing intervals.
  setTimeout(async () => {
    if (Genesis.UI.boot.ready) return;
    try {
      const h = await window.genesis.invoke('agent:get-health');
      if (h && !Genesis.UI.boot.ready) Genesis.UI.boot.onReady({ state: 'ready', model: h.model?.active || null });
    } catch (e) { console.debug('[UI] immediate boot poll:', e.message); }
  }, 200);
  window.genesis.invoke('agent:get-health').then(h => { if (h&&!Genesis.UI.boot.ready) Genesis.UI.boot.onReady({ state: 'ready', model: h.model?.active || null }); }).catch((e) => { console.debug('[UI] initial health poll failed:', e.message); });
  // v7.1.0: More aggressive retries — 1s, 2s, 3s, 5s, 10s, 30s
  // Also accept health response even without model (agent is ready, model may still be loading)
  for (const d of [1000,2000,3000,5000,10000,30000]) setTimeout(async () => { if (Genesis.UI.boot.ready) return; try { const h = await window.genesis.invoke('agent:get-health'); if (h) Genesis.UI.boot.onReady({ state: 'ready', model: h.model?.active || null }); } catch (e) { console.debug('[UI] boot retry failed:', e.message); } }, d);
});
