// ============================================================
// GENESIS UI — modules/editor.js
// Monaco Editor integration: init, open/save files, sandbox.
// ============================================================

const { t } = require('./i18n');

const $ = (sel) => document.querySelector(sel);

let monacoEditor = null;
let currentFile = null;

function initMonaco() {
  const localPath = '../../node_modules/monaco-editor/min/vs';
  const cdnPath = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs';

  function bootstrapMonaco() {
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
    console.debug('[UI] Monaco Editor ready');
  }

  /* global require:false, monaco:false */
  if (typeof require === 'function' && typeof require.config === 'function') {
    require.config({ paths: { vs: localPath } });
    require(['vs/editor/editor.main'], bootstrapMonaco, function () {
      console.debug('[UI] Local Monaco not found, trying CDN...');
      require.config({ paths: { vs: cdnPath } });
      require(['vs/editor/editor.main'], bootstrapMonaco);
    });
  }
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
