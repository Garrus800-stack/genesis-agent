// ============================================================
// GENESIS — src/ui/boot-overlay.js (v7.9.41 r6, U3-light)
// Honest boot feedback from second one: a calm full-screen layer
// with the wordmark, a pulse bar and elapsed seconds. No slogans.
// Removed by main.js via window.__genesisBootComplete() the moment
// the agent finishes booting; turns static on boot failure.
// ============================================================
(function () {
  'use strict';
  if (window.__genesisBootAlreadyDone) return; // boot beat the DOM — nothing to show

  const css = [
    '#genesis-boot-overlay{position:fixed;inset:0;z-index:99999;background:#0a0a0f;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center;',
    'font-family:Segoe UI,system-ui,sans-serif;color:#e8e8ef;transition:opacity .45s ease}',
    '#genesis-boot-overlay .gb-mark{font-size:26px;letter-spacing:.55em;font-weight:600;',
    'padding-left:.55em;color:#e8e8ef;opacity:.92}',
    '#genesis-boot-overlay .gb-bar{width:220px;height:2px;margin:26px 0 18px;',
    'background:#1c1c26;border-radius:2px;overflow:hidden}',
    '#genesis-boot-overlay .gb-bar i{display:block;height:100%;width:38%;',
    'background:#5b8cff;border-radius:2px;animation:gbSlide 1.4s ease-in-out infinite}',
    '@keyframes gbSlide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}',
    '#genesis-boot-overlay .gb-line{font-size:12.5px;color:#9a9aa8;letter-spacing:.04em}',
    '#genesis-boot-overlay .gb-sub{font-size:11px;color:#5e5e6c;margin-top:7px}',
    '#genesis-boot-overlay.gb-error .gb-bar i{animation:none;width:100%;background:#c05a5a}',
  ].join('');

  const style = document.createElement('style');
  style.id = 'genesis-boot-overlay-style';
  style.textContent = css;

  const el = document.createElement('div');
  el.id = 'genesis-boot-overlay';
  el.innerHTML =
    '<div class="gb-mark">GENESIS</div>' +
    '<div class="gb-bar"><i></i></div>' +
    '<div class="gb-line">Loading services &middot; <span id="gb-secs">0</span>s</div>' +
    '<div class="gb-sub">First start may take a little longer</div>';

  const mount = () => {
    if (window.__genesisBootAlreadyDone) return;
    document.head.appendChild(style);
    document.body.appendChild(el);
    const t0 = Date.now();
    const tick = setInterval(() => {
      const s = document.getElementById('gb-secs');
      if (s) s.textContent = String(Math.floor((Date.now() - t0) / 1000));
    }, 1000);

    window.__genesisBootComplete = function () {
      clearInterval(tick);
      el.style.opacity = '0';
      setTimeout(() => { el.remove(); style.remove(); }, 500);
    };
    window.__genesisBootFailed = function (msg) {
      clearInterval(tick);
      el.classList.add('gb-error');
      const line = el.querySelector('.gb-line');
      if (line) line.textContent = 'Boot failed — ' + (msg || 'see log for details');
    };
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
