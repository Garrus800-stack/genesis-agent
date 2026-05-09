// ============================================================
// GENESIS UI — modules/editor.js
// Monaco Editor integration: init, open/save files, sandbox.
// ============================================================

const { t } = require('./i18n');

const $ = (sel) => document.querySelector(sel);

let monacoEditor = null;
let currentFile = null;

function initMonaco() {
  // v7.7.5: AMD → ESM migration. Monaco is now loaded via dist/monaco/monaco.bundle.js
  // (script tag in index.html), which sets window.monaco via esbuild's globalName.
  // No loader.js, no require.config(), no CDN fallback. Workers are separate
  // pre-built IIFE bundles in dist/monaco/<lang>.worker.js, lazy-loaded by Monaco
  // when the editor encounters that language. The ts.worker handles both
  // TypeScript and plain JavaScript (autocomplete + diagnostics).
  /* global monaco:false */
  if (typeof monaco === 'undefined') {
    console.warn('[UI] Monaco not loaded — dist/monaco/monaco.bundle.js missing? (run npm install)');
    return;
  }

  // Worker setup MUST happen before monaco.editor.create().
  // Map Monaco's language label → worker filename.
  const workerMap = {
    json: 'json',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', handlebars: 'html', razor: 'html',
    typescript: 'ts', javascript: 'ts',
  };
  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      const file = (workerMap[label] || 'editor') + '.worker.js';
      const url = new URL(`../../dist/monaco/${file}`, window.location.href);
      return new Worker(url.href);
    },
  };

  monacoEditor = monaco.editor.create(document.getElementById('monaco-container'), {
    value: '// Genesis Agent\n// Select a file from the file tree to begin editing.\n',
    language: 'javascript',
    theme: 'vs-dark',
    minimap: { enabled: false },
    fontSize: 13,
    wordWrap: 'on',
    automaticLayout: true,
    tabSize: 2,
    scrollBeyondLastLine: false,
  });
  monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);
  console.debug('[UI] Monaco Editor ready (local ESM bundle)');
}

async function openFile(filePath) {
  if (!monacoEditor) return;
  try {
    const content = await window.genesis.invoke('agent:get-file', filePath);
    if (content !== null && typeof monaco !== 'undefined') {
      currentFile = filePath;
      const lang = filePath.endsWith('.json') ? 'json' : filePath.endsWith('.html') ? 'html'
        : filePath.endsWith('.css') ? 'css' : filePath.endsWith('.md') ? 'markdown' : 'javascript';
      monacoEditor.setModel(monaco.editor.createModel(content, lang));
      $('#editor-filename').textContent = filePath;
    }
  } catch (err) { console.warn('[EDITOR] Open failed:', err.message); }
}

async function saveCurrentFile() {
  if (!monacoEditor || !currentFile) return;
  try {
    await window.genesis.invoke('agent:save-file', { filePath: currentFile, content: monacoEditor.getValue() });
    const { showToast } = require('./statusbar');
    showToast(t('ui.saved', { file: currentFile }), 'success');
  } catch (err) { console.warn('[EDITOR] Save failed:', err.message); }
}

async function runInSandbox() {
  if (!monacoEditor) return;
  const code = monacoEditor.getModel().getValueInRange(monacoEditor.getSelection()) || monacoEditor.getValue();
  try {
    const result = await window.genesis.invoke('agent:run-in-sandbox', code);
    const outputEl = $('#sandbox-output');
    const el = $('#sandbox-result');
    el.textContent = result?.output || result?.error || JSON.stringify(result, null, 2);
    outputEl.classList.remove('hidden');
  } catch (err) { console.warn('[SANDBOX] Run failed:', err.message); }
}

function getEditor() { return monacoEditor; }
function getCurrentFile() { return currentFile; }
function setCurrentFile(f) { currentFile = f; }

// v6.0.2: Set editor content directly from chat code buttons
function setEditorContent(content, lang) {
  if (monacoEditor && typeof monaco !== 'undefined') {
    monacoEditor.setModel(monaco.editor.createModel(content, lang || 'plaintext'));
  }
}

module.exports = { initMonaco, openFile, saveCurrentFile, runInSandbox, getEditor, getCurrentFile, setCurrentFile, setEditorContent };
