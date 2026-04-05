// ============================================================
// GENESIS UI — modules/i18n.js
// Internationalization: string lookup, DOM patching, language switching.
// ============================================================

let _strings = {};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function t(key, vars = {}) {
  let str = _strings[key] || key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

function applyI18n() {
  for (const el of $$('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated !== key) el.textContent = translated;
  }
  for (const el of $$('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = t(key);
    if (translated !== key) el.placeholder = translated;
  }
}

async function loadI18n() {
  try {
    _strings = await window.genesis.invoke('agent:get-lang-strings');
    applyI18n();
    const sel = $('#lang-select');
    if (sel && _strings._lang) sel.value = _strings._lang;
  } catch (err) { console.debug('[I18N] Load failed:', err.message); }
}

module.exports = { t, applyI18n, loadI18n };
