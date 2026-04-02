// ============================================================
// GENESIS — test/modules/dashboard.test.js
// UI tests for dashboard.js
//
// STRATEGY:
//   Same vm.createContext + vm.runInContext approach as renderer.test.js.
//   dashboard.js defines a Dashboard class, instantiates it as
//   window._genesis_dashboard, and auto-injects on DOMContentLoaded.
//   We mock the DOM and window.genesis, load the script, then test
//   each render method and interaction.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Minimal DOM Shim ────────────────────────────────────────

function createMiniDOM() {
  const elements = {};
  const eventListeners = {};

  function makeElement(tag = 'div') {
    let _innerHTML = '';
    let _tc = '';
    const el = {
      tagName: (tag || 'div').toUpperCase(), className: '', id: '',
      get innerHTML() { return _innerHTML; },
      set innerHTML(v) { _innerHTML = v; if (v === '') el.children = []; },
      get textContent() { return _tc; },
      set textContent(v) {
        _tc = v;
        _innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
      placeholder: '', value: '', title: '',
      style: { height: '' },
      children: [], _attrs: {}, _listeners: {}, _classList: new Set(),
      classList: {
        add(c) { el._classList.add(c); },
        remove(c) { el._classList.delete(c); },
        toggle(c, force) {
          if (force === true) el._classList.add(c);
          else if (force === false) el._classList.delete(c);
          else if (el._classList.has(c)) el._classList.delete(c);
          else el._classList.add(c);
        },
        contains(c) { return el._classList.has(c); },
      },
      getAttribute(n) { return el._attrs[n] !== undefined ? el._attrs[n] : null; },
      setAttribute(n, v) { el._attrs[n] = v; },
      appendChild(c) { el.children.push(c); return c; },
      prepend(c) { el.children.unshift(c); },
      removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
      remove() {},
      get firstChild() { return el.children[0] || null; },
      querySelector(sel) {
        if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          for (const child of el.children) {
            if (child._classList?.has(cls)) return child;
          }
        }
        return null;
      },
      querySelectorAll() { return []; },
      addEventListener(ev, fn) {
        if (!el._listeners[ev]) el._listeners[ev] = [];
        el._listeners[ev].push(fn);
      },
      closest() { return null; },
      get scrollHeight() { return 500; },
      set scrollTop(v) { el._st = v; },
      get scrollTop() { return el._st || 0; },
    };
    return el;
  }

  // Pre-create elements dashboard.js references
  const ids = [
    'main-layout', 'dashboard-panel', 'btn-dashboard',
    'dash-organism-body', 'dash-loop-body', 'dash-vitals-body',
    'dash-cognitive-body', 'dash-memory-body', 'dash-system-body',
  ];
  for (const id of ids) {
    elements[id] = makeElement('div');
    elements[id].id = id;
  }

  // topbar-center for button injection
  const topbarCenter = makeElement('div');
  topbarCenter._classList.add('topbar-center');
  elements['_topbar-center'] = topbarCenter;

  const doc = {
    querySelector(sel) {
      if (sel.startsWith('#')) return elements[sel.slice(1)] || null;
      if (sel === '.topbar-center') return topbarCenter;
      return null;
    },
    querySelectorAll() { return []; },
    getElementById(id) { return elements[id] || null; },
    createElement(tag) { return makeElement(tag); },
    addEventListener(ev, fn) {
      if (!eventListeners[ev]) eventListeners[ev] = [];
      eventListeners[ev].push(fn);
      if (ev === 'DOMContentLoaded') {
        if (!doc._domContentLoadedCallbacks) doc._domContentLoadedCallbacks = [];
        doc._domContentLoadedCallbacks.push(fn);
      }
    },
    head: { appendChild() {} },
    body: makeElement('body'),
  };

  return { doc, elements, eventListeners, makeElement };
}


// ── window.genesis Mock ─────────────────────────────────────

function createGenesisMock() {
  const listeners = {};
  const invokeMock = {};

  return {
    mock: {
      invoke: async (channel, ...args) => {
        if (invokeMock[channel]) return invokeMock[channel](...args);
        return null;
      },
      send() {},
      on(channel, cb) {
        if (!listeners[channel]) listeners[channel] = [];
        listeners[channel].push(cb);
        return () => {
          const idx = listeners[channel].indexOf(cb);
          if (idx >= 0) listeners[channel].splice(idx, 1);
        };
      },
    },
    emit(channel, ...args) {
      for (const cb of (listeners[channel] || [])) cb(...args);
    },
    setInvokeHandler(channel, fn) { invokeMock[channel] = fn; },
    listeners,
  };
}


// ── Load dashboard.js + delegates into sandbox ──────────────

function loadDashboard() {
  const { doc, elements, eventListeners, makeElement } = createMiniDOM();
  const genesis = createGenesisMock();

  const ctx = vm.createContext({
    document: doc,
    window: { genesis: genesis.mock, _genesis_dashboard: null, _dashApprove: null, _dashReject: null },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout: () => 1,
    setInterval: (fn, ms) => { return 1; },
    clearInterval: () => {},
    Object,
    Date,
    Math,
    Array,
    String,
    Number,
    Error,
    Promise,
  });
  ctx.window.document = doc;

  // v5.4.0: Load delegates first (they define global applyRenderers/applyStyles)
  const uiDir = path.join(__dirname, '..', '..', 'src', 'ui');
  const renderersSrc = fs.readFileSync(path.join(uiDir, 'DashboardRenderers.js'), 'utf8');
  const stylesSrc = fs.readFileSync(path.join(uiDir, 'DashboardStyles.js'), 'utf8');
  let src = fs.readFileSync(path.join(uiDir, 'dashboard.js'), 'utf8');

  vm.runInContext(renderersSrc, ctx, { filename: 'DashboardRenderers.js' });
  vm.runInContext(stylesSrc, ctx, { filename: 'DashboardStyles.js' });
  vm.runInContext(src, ctx, { filename: 'dashboard.js' });

  // Fire DOMContentLoaded from within the vm to trigger inject()
  vm.runInContext(`
    (function() {
      var cbs = document._domContentLoadedCallbacks || [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](); } catch(e) {}
      }
    })();
  `, ctx);

  function run(code) { return vm.runInContext(code, ctx); }

  // Dashboard API proxy
  const dash = {
    toggle() { run('window._genesis_dashboard.toggle()'); },
    refresh() { return run('window._genesis_dashboard.refresh()'); },
    get visible() { return run('window._genesis_dashboard._visible'); },
    get moodHistory() { return run('window._genesis_dashboard._moodHistory'); },
    get lastHealth() { return run('window._genesis_dashboard._lastHealth'); },

    renderOrganism(data) { ctx._arg = data; run('window._genesis_dashboard._renderOrganism(_arg)'); },
    renderVitals(data) { ctx._arg = data; run('window._genesis_dashboard._renderVitals(_arg)'); },
    renderAgentLoop(data) { ctx._arg = data; run('window._genesis_dashboard._renderAgentLoop(_arg)'); },
    renderCognitive(cog, mon) {
      ctx._args = [cog, mon];
      run('window._genesis_dashboard._renderCognitive(_args[0], _args[1])');
    },
    renderMemory(health, session) {
      ctx._args = [health, session];
      run('window._genesis_dashboard._renderMemory(_args[0], _args[1])');
    },
    renderSystem(health) { ctx._arg = health; run('window._genesis_dashboard._renderSystem(_arg)'); },
    formatUptime(s) { ctx._arg = s; return run('window._genesis_dashboard._formatUptime(_arg)'); },
    moodEmoji(m) { ctx._arg = m; return run('window._genesis_dashboard._moodEmoji(_arg)'); },
    buildSparkline() { return run('window._genesis_dashboard._buildSparkline()'); },
    buildNeedsRadar(n) { ctx._arg = n; return run('window._genesis_dashboard._buildNeedsRadar(_arg)'); },
    buildHTML() { return run('window._genesis_dashboard._buildHTML()'); },
    buildCSS() { return run('window._genesis_dashboard._buildCSS()'); },
  };

  return { dash, elements, genesis, ctx, run, doc };
}


// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('dashboard.js — constructor & inject', () => {

  test('Dashboard instance created on window', () => {
    const { run } = loadDashboard();
    assert(run('window._genesis_dashboard !== null'), 'Dashboard instance exists');
    assert(run('window._genesis_dashboard instanceof Dashboard'), 'Is Dashboard class');
  });

  test('inject creates dashboard panel element', () => {
    const { elements } = loadDashboard();
    const panel = elements['dashboard-panel'];
    assert(panel, 'Dashboard panel exists');
  });

  test('inject creates dashboard button in topbar', () => {
    const { elements } = loadDashboard();
    const topbar = elements['_topbar-center'];
    assert(topbar.children.length >= 1, 'Button injected into topbar');
    const btn = topbar.children[0];
    assertEqual(btn.id, 'btn-dashboard');
    assert(btn.className.includes('topbar-btn'), 'Has topbar-btn class');
  });

  test('inject registers IPC event listeners', () => {
    const { genesis } = loadDashboard();
    assert(genesis.listeners['agent:loop-approval-needed']?.length >= 1, 'Approval listener wired');
    assert(genesis.listeners['agent:loop-progress']?.length >= 1, 'Progress listener wired');
  });

  test('starts hidden', () => {
    const { dash } = loadDashboard();
    assert(!dash.visible, 'Dashboard starts hidden');
  });
});


describe('dashboard.js — toggle', () => {

  test('toggle shows the panel', () => {
    const { dash, elements } = loadDashboard();
    dash.toggle();
    assert(dash.visible, 'Visible after toggle');
  });

  test('toggle again hides the panel', () => {
    const { dash } = loadDashboard();
    dash.toggle();
    dash.toggle();
    assert(!dash.visible, 'Hidden after second toggle');
  });
});


describe('dashboard.js — _formatUptime', () => {

  test('formats seconds', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.formatUptime(30), '30s');
  });

  test('formats minutes', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.formatUptime(120), '2m');
  });

  test('formats hours and minutes', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.formatUptime(3660), '1h 1m');
  });
});


describe('dashboard.js — _moodEmoji', () => {

  test('returns correct emoji for known moods', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.moodEmoji('curious'), '🧐');
    assertEqual(dash.moodEmoji('frustrated'), '😤');
    assertEqual(dash.moodEmoji('content'), '😌');
    assertEqual(dash.moodEmoji('focused'), '🎯');
  });

  test('returns default emoji for unknown mood', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.moodEmoji('confused'), '🌿');
  });
});


describe('dashboard.js — _renderOrganism', () => {

  test('shows "Not available" when no organism data', () => {
    const { dash, elements } = loadDashboard();
    dash.renderOrganism(null);
    assert(elements['dash-organism-body'].innerHTML.includes('Not available'));
  });

  test('renders mood ring and emotion bars', () => {
    const { dash, elements } = loadDashboard();
    dash.renderOrganism({
      emotions: {
        mood: 'curious',
        trend: 'rising',
        dominant: 'curiosity',
        state: { curiosity: 0.8, satisfaction: 0.6, frustration: 0.1, energy: 0.7, loneliness: 0.2 },
      },
      needs: { needs: { learning: 0.7, social: 0.3 }, totalDrive: 0.65, recommendations: [] },
    });
    const html = elements['dash-organism-body'].innerHTML;
    assert(html.includes('dash-mood-ring'), 'Has mood ring');
    assert(html.includes('curious'), 'Shows mood label');
    assert(html.includes('dash-bar-row'), 'Has emotion bars');
    assert(html.includes('↗'), 'Shows rising trend');
  });

  test('tracks mood history', () => {
    const { dash } = loadDashboard();
    dash.renderOrganism({
      emotions: { mood: 'calm', state: { energy: 0.5 } },
    });
    dash.renderOrganism({
      emotions: { mood: 'curious', state: { energy: 0.7 } },
    });
    const history = dash.moodHistory;
    assertEqual(history.length, 2);
  });

  test('renders recommendations', () => {
    const { dash, elements } = loadDashboard();
    dash.renderOrganism({
      emotions: { mood: 'calm', state: {} },
      needs: {
        needs: {},
        recommendations: [{ activity: 'explore' }, { activity: 'rest' }],
      },
    });
    const html = elements['dash-organism-body'].innerHTML;
    assert(html.includes('dash-rec-tag'), 'Has recommendation tags');
    assert(html.includes('explore'), 'Shows explore rec');
  });
});


describe('dashboard.js — _renderVitals', () => {

  test('shows "Not available" when no homeostasis', () => {
    const { dash, elements } = loadDashboard();
    dash.renderVitals({});
    assert(elements['dash-vitals-body'].innerHTML.includes('Not available'));
  });

  test('renders state badge and vitals', () => {
    const { dash, elements } = loadDashboard();
    dash.renderVitals({
      organism: {
        homeostasis: {
          state: 'healthy',
          vitals: {
            cpu: { value: 0.45, status: 'healthy', unit: '%' },
            memory: { value: 0.72, status: 'warning', unit: '%' },
          },
          errorRate: 0.02,
          autonomyAllowed: true,
        },
      },
    });
    const html = elements['dash-vitals-body'].innerHTML;
    assert(html.includes('HEALTHY'), 'State badge shown');
    assert(html.includes('#639922'), 'Healthy color');
    assert(html.includes('dash-vital-row'), 'Has vital rows');
    assert(html.includes('2.0%'), 'Error rate displayed');
  });

  test('shows autonomy warning when paused', () => {
    const { dash, elements } = loadDashboard();
    dash.renderVitals({
      organism: {
        homeostasis: {
          state: 'stressed',
          vitals: {},
          autonomyAllowed: false,
        },
      },
    });
    assert(elements['dash-vitals-body'].innerHTML.includes('Autonomy paused'));
  });
});


describe('dashboard.js — _renderAgentLoop', () => {

  test('shows idle when no status', () => {
    const { dash, elements } = loadDashboard();
    dash.renderAgentLoop(null);
    assert(elements['dash-loop-body'].innerHTML.includes('Idle'));
  });

  test('shows idle when not running', () => {
    const { dash, elements } = loadDashboard();
    dash.renderAgentLoop({ running: false });
    assert(elements['dash-loop-body'].innerHTML.includes('Idle'));
  });

  test('renders progress and log when running', () => {
    const { dash, elements } = loadDashboard();
    dash.renderAgentLoop({
      running: true,
      stepCount: 5,
      consecutiveErrors: 1,
      recentLog: [
        { step: 1, type: 'action', description: 'Called tool X' },
        { step: 2, type: 'think', description: 'Evaluating result', error: true },
      ],
    });
    const html = elements['dash-loop-body'].innerHTML;
    assert(html.includes('dash-progress-fill'), 'Progress bar shown');
    assert(html.includes('Step 5'), 'Step count shown');
    assert(html.includes('1 errors'), 'Error count shown');
    assert(html.includes('dash-log-entry'), 'Log entries shown');
    assert(html.includes('dash-log-err'), 'Error log highlighted');
  });

  test('shows approval buttons when pending', () => {
    const { dash, elements } = loadDashboard();
    dash.renderAgentLoop({
      running: true, stepCount: 1, consecutiveErrors: 0,
      recentLog: [],
      pendingApproval: { description: 'Delete file.js?' },
    });
    const html = elements['dash-loop-body'].innerHTML;
    assert(html.includes('dash-approval'), 'Approval section shown');
    assert(html.includes('Delete file.js?'), 'Approval text shown');
    assert(html.includes('Approve'), 'Approve button');
    assert(html.includes('Reject'), 'Reject button');
  });
});


describe('dashboard.js — _renderCognitive', () => {

  test('shows "Not available" when no data', () => {
    const { dash, elements } = loadDashboard();
    dash.renderCognitive(null, null);
    assert(elements['dash-cognitive-body'].innerHTML.includes('Not available'));
  });

  test('renders verifier stats', () => {
    const { dash, elements } = loadDashboard();
    dash.renderCognitive({
      verifier: { pass: 8, fail: 2, ambiguous: 0 },
    }, null);
    const html = elements['dash-cognitive-body'].innerHTML;
    assert(html.includes('Verifications'), 'Verifier section shown');
    assert(html.includes('80% pass'), 'Pass rate calculated');
  });

  test('renders world state and meta-learning', () => {
    const { dash, elements } = loadDashboard();
    dash.renderCognitive({
      worldState: { ollamaStatus: 'running', recentFiles: 3 },
      metaLearning: { recordings: 12, strategies: 4 },
    }, null);
    const html = elements['dash-cognitive-body'].innerHTML;
    assert(html.includes('dash-ok'), 'Ollama running green');
    assert(html.includes('Modified files'), 'Recent files shown');
    assert(html.includes('12'), 'ML recordings shown');
  });

  test('renders cognitive monitor data', () => {
    const { dash, elements } = loadDashboard();
    dash.renderCognitive(null, { anomalies: 2, confidenceAvg: 0.85 });
    const html = elements['dash-cognitive-body'].innerHTML;
    assert(html.includes('Anomalies'), 'Anomalies shown');
    assert(html.includes('85%'), 'Confidence shown');
  });
});


describe('dashboard.js — _renderMemory', () => {

  test('shows "No data" when empty', () => {
    const { dash, elements } = loadDashboard();
    dash.renderMemory({}, null);
    assert(elements['dash-memory-body'].innerHTML.includes('No data'));
  });

  test('renders memory stats', () => {
    const { dash, elements } = loadDashboard();
    dash.renderMemory({
      memory: { facts: 42, episodes: 7 },
      knowledgeGraph: { nodes: 128 },
      unifiedMemory: { searchCount: 55 },
      embeddings: { available: true, model: 'nomic', dimensions: 768 },
    }, {
      sessionHistory: 15,
      currentSession: { messageCount: 8, duration: '12m' },
      userProfile: { name: 'Garrus' },
    });
    const html = elements['dash-memory-body'].innerHTML;
    assert(html.includes('42'), 'Facts count');
    assert(html.includes('128'), 'KG nodes');
    assert(html.includes('nomic'), 'Embedding model');
    assert(html.includes('768'), 'Dimensions');
    assert(html.includes('Garrus'), 'User name');
    assert(html.includes('8 msgs'), 'Session messages');
  });
});


describe('dashboard.js — _renderSystem', () => {

  test('shows "No data" when empty', () => {
    const { dash, elements } = loadDashboard();
    dash.renderSystem(null);
    assert(elements['dash-system-body'].innerHTML.includes('No data'));
  });

  test('renders system overview', () => {
    const { dash, elements } = loadDashboard();
    dash.renderSystem({
      uptime: 3661,
      services: 12,
      tools: 9,
      model: { active: 'gemma2:9b' },
      circuit: { state: 'CLOSED' },
      idleMind: { thoughtCount: 42 },
      goals: { active: 3, total: 7 },
      shell: { totalCommands: 15 },
      storage: { writes: 88 },
      mcp: { connectedCount: 2, serverCount: 3 },
      intervals: [
        { name: 'daemon', paused: false },
        { name: 'health', paused: true },
      ],
    });
    const html = elements['dash-system-body'].innerHTML;
    assert(html.includes('1h 1m'), 'Uptime formatted');
    assert(html.includes('gemma2:9b'), 'Model shown');
    assert(html.includes('CLOSED'), 'Circuit state');
    assert(html.includes('#639922'), 'Circuit green for CLOSED');
    assert(html.includes('42 thoughts'), 'IdleMind thoughts');
    assert(html.includes('3/7'), 'Goals ratio');
    assert(html.includes('88'), 'Storage writes');
    assert(html.includes('2/3 servers'), 'MCP count');
    assert(html.includes('dash-paused'), 'Paused interval class');
  });

  test('circuit breaker colors', () => {
    const { dash, elements } = loadDashboard();
    dash.renderSystem({
      circuit: { state: 'OPEN' },
      uptime: 10,
    });
    assert(elements['dash-system-body'].innerHTML.includes('#e24b4a'), 'OPEN is red');

    dash.renderSystem({
      circuit: { state: 'HALF_OPEN' },
      uptime: 10,
    });
    assert(elements['dash-system-body'].innerHTML.includes('#ef9f27'), 'HALF_OPEN is orange');
  });
});


describe('dashboard.js — _buildSparkline', () => {

  test('returns empty string with insufficient data', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.buildSparkline(), '');
  });

  test('builds SVG sparkline with enough data points', () => {
    const { dash } = loadDashboard();
    // Push enough mood history points
    for (let i = 0; i < 5; i++) {
      dash.renderOrganism({
        emotions: { mood: 'calm', state: { energy: 0.3 + i * 0.1 } },
      });
    }
    const svg = dash.buildSparkline();
    assert(svg.includes('<svg'), 'Contains SVG element');
    assert(svg.includes('path'), 'Contains path element');
    assert(svg.includes('#5dcaa5'), 'Energy line color');
  });
});


describe('dashboard.js — _buildNeedsRadar', () => {

  test('returns empty for empty needs', () => {
    const { dash } = loadDashboard();
    assertEqual(dash.buildNeedsRadar({}), '');
  });

  test('builds SVG radar chart', () => {
    const { dash } = loadDashboard();
    const svg = dash.buildNeedsRadar({
      learning: 0.8,
      social: 0.4,
      rest: 0.6,
    });
    assert(svg.includes('<svg'), 'Contains SVG');
    assert(svg.includes('polygon'), 'Contains polygon');
    assert(svg.includes('learn'), 'Has axis label (truncated)');
    assert(svg.includes('socia'), 'Has axis label');
  });
});


describe('dashboard.js — _buildHTML & _buildCSS', () => {

  test('buildHTML contains all six sections', () => {
    const { dash } = loadDashboard();
    const html = dash.buildHTML();
    assert(html.includes('dash-organism-body'), 'Organism section');
    assert(html.includes('dash-loop-body'), 'Agent Loop section');
    assert(html.includes('dash-vitals-body'), 'Vitals section');
    assert(html.includes('dash-cognitive-body'), 'Cognitive section');
    assert(html.includes('dash-memory-body'), 'Memory section');
    assert(html.includes('dash-system-body'), 'System section');
  });

  test('buildCSS returns valid CSS string', () => {
    const { dash } = loadDashboard();
    const css = dash.buildCSS();
    assert(css.includes('#dashboard-panel'), 'Has panel selector');
    assert(css.includes('.dash-mood-ring'), 'Has mood ring styles');
    assert(css.includes('.dash-bar-fill'), 'Has bar fill styles');
    assert(css.length > 500, 'CSS has substantial content');
  });
});


describe('dashboard.js — global hooks', () => {

  test('_dashApprove calls loop-approve IPC', () => {
    const { genesis, run } = loadDashboard();
    let called = false;
    genesis.setInvokeHandler('agent:loop-approve', () => { called = true; });
    run('window._dashApprove()');
    assert(called, 'loop-approve was invoked');
  });

  test('_dashReject calls loop-reject IPC', () => {
    const { genesis, run } = loadDashboard();
    let called = false;
    genesis.setInvokeHandler('agent:loop-reject', () => { called = true; });
    run('window._dashReject()');
    assert(called, 'loop-reject was invoked');
  });
});

run();
