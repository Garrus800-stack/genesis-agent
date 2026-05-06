// @ts-checked-v7.5.9
// ============================================================
// GENESIS — CommandHandlersArchitecture.js
// ZIP 4 Phase 8 + ZIP 5 Phase 8b (v7.5.9)
//
// Universal architecture-diagram skill. Default output is ASCII —
// always renders, no CDN, no library load. Mermaid is opt-in via
// "--mermaid" flag or natural-language phrase ("als grafik", "als
// diagramm", "als bild"). Earlier versions defaulted to Mermaid
// and the user saw a permanent "[Diagramm wird geladen…]" if the
// CDN was slow or blocked.
//
// Scope:
//   /architecture                     — Genesis self
//   /architecture <path>              — external project at <path>
//   /architecture --mermaid           — Genesis in Mermaid
//   /architecture <path> --mermaid    — external in Mermaid
//   /diagram, /arch                   — aliases (incl. external)
//
// Free-text:
//   "zeig mir das als diagramm"       — Genesis self in ASCII
//   "diagramm vom github ordner"      — external (path resolved
//                                       via folder-aliases)
//   "architektur von C:\\my-project"  — external direct path
//
// External-project source:
//   Tier 1 — manifest files (package.json, requirements.txt,
//            go.mod, Cargo.toml, pyproject.toml, composer.json)
//   Tier 2 — source-scan (top-level dirs, file counts by ext)
//   Both layers run, and the renderer picks the richer signal.
//
// Path safety: 3-tier sandbox via Safety.checkRootDirSandbox.
// Trust 0 = project root only. Trust 1 = + user-home read.
// Trust 2+ = broader (still no system / secret paths).
//
// Prototype-Delegation from CommandHandlers.js via Object.assign.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CommandHandlersArchitecture');

const _PHASE_LABELS = {
  0: 'Bootstrap', 1: 'Foundation', 2: 'Intelligence', 3: 'Capabilities',
  4: 'Cognition', 5: 'Hexagonal', 6: 'Autonomy', 7: 'Cognitive',
  8: 'Embodiment', 9: 'Cognitive-Ext', 10: 'Adaptive', 11: 'Trust',
  12: 'Reasoning',
};

const _LANG_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.cpp': 'C++',
  '.c': 'C', '.h': 'C-Header', '.swift': 'Swift', '.php': 'PHP',
  '.html': 'HTML', '.css': 'CSS', '.vue': 'Vue', '.svelte': 'Svelte',
};

const _MANIFEST_READERS = {
  'package.json': '_readPackageJson',
  'requirements.txt': '_readRequirementsTxt',
  'pyproject.toml': '_readPyproject',
  'go.mod': '_readGoMod',
  'Cargo.toml': '_readCargoToml',
  'composer.json': '_readComposerJson',
};

const _SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  '.venv', 'venv', 'env', 'vendor', '.next', '.nuxt', '.cache',
  'coverage', '.pytest_cache', '.mypy_cache', '.tox', 'out', 'bin',
  'obj', '.idea', '.vscode',
]);

const CommandHandlersArchitecture = {

  async architectureDiagram(message) {
    const parsed = this._parseArchRequest(message);

    // Disambiguation guard: a free-text message with neither
    // architecture keywords nor a slash-form is most likely an
    // AdHoc mermaid request misrouted here by the LLM (e.g. user
    // says "zeige X in einem mermaid" — that's not /architecture).
    // Without this guard the handler defaulted to Genesis-Self,
    // confusing the user.
    const hadSlash = /(?:^|\s)\/(?:architecture|architecture-diagram|arch|diagram)\b/i.test(message);
    const hasArchKeyword = /(?:architektur|architecture|struktur|diagramm|services|phasen|phases|modules?\b|self-?model)/i.test(message);
    if (!hadSlash && !hasArchKeyword && !parsed.targetPath) {
      return 'Das sieht nach einem einfachen Mermaid-Diagramm aus, nicht nach einer Architektur-Anfrage. Beschreib einfach was es zeigen soll (z. B. "zeichne ein Diagramm mit einem Knoten Genesis"), oder nutze `/architecture` für meine eigene Architektur.';
    }

    // Genesis self.
    if (!parsed.targetPath) {
      const sm = this.selfModel;
      if (!sm || typeof sm.getFullModel !== 'function') {
        return 'Architektur-Daten nicht verfügbar (selfModel nicht initialisiert).';
      }
      const meta = sm._manifestMeta;
      if (!meta || Object.keys(meta).length === 0) {
        return 'Manifest-Metadaten nicht verfügbar — Architektur-Diagramm benötigt boot-phase-Info.';
      }
      const data = this._collectGenesisData(sm, meta);
      return parsed.format === 'mermaid'
        ? this._renderMermaidGenesis(data)
        : this._renderAsciiGenesis(data);
    }

    // External project. Resolve path (incl. folder-aliases like
    // "desktop", "github ordner") and gate via 3-tier sandbox.
    const resolved = this._resolveExternalPath(parsed.targetPath);
    if (!resolved.ok) return resolved.error;

    const data = await this._collectExternalData(resolved.absPath);
    if (data.error) return data.error;
    return parsed.format === 'mermaid'
      ? this._renderMermaidExternal(data)
      : this._renderAsciiExternal(data);
  },

  // ── Parsing ──────────────────────────────────────────────────

  _parseArchRequest(message) {
    const out = { targetPath: null, format: 'ascii' };
    if (typeof message !== 'string') return out;

    // 1. Format flag. Mermaid is opt-in.
    if (/--mermaid\b/i.test(message)) out.format = 'mermaid';
    else if (/\b(?:als|in|im)\s+(?:mermaid|grafik|bild|svg)\b/i.test(message)) out.format = 'mermaid';
    else if (/\bmermaid\b/i.test(message) && !/\bnicht\s+mermaid\b/i.test(message)) {
      // Free-text: word "mermaid" anywhere flips to mermaid unless
      // negated. Prevents the Genesis-default-LLM from confabulating
      // its own Mermaid output when user asks "in Mermaid".
      out.format = 'mermaid';
    }

    // 2. Strip flags before path detection.
    let work = message
      .replace(/--mermaid\b/ig, '')
      .replace(/\b(?:als|in|im)\s+(?:mermaid|grafik|bild|ascii|svg)\b/ig, '');

    // 3. Slash-command form: /architecture [path] / /diagram [path] / /arch [path]
    const slashMatch = work.match(/(?:^|\s)\/(?:architecture|architecture-diagram|arch|diagram)\b\s*(.*)/i);
    if (slashMatch) {
      const tail = slashMatch[1].trim();
      if (tail) out.targetPath = tail.split(/\s+/)[0];
      return out;
    }

    // 4. Free-text. Trigger phrases:
    //    "diagramm vom <X>", "architektur von <X>", "zeig <X> als diagramm"
    //    Path can be a folder-alias ("desktop", "github ordner") or
    //    an absolute path.
    const ftMatch = work.match(
      /(?:diagramm|architektur|struktur)\s+(?:von|vom|f[üu]r|of)\s+(?:dem|der|den|the|my)?\s*(.+?)(?:\s+(?:zeigen|ordner|projekt|repo|repository))?\s*$/i
    );
    if (ftMatch) {
      out.targetPath = ftMatch[1].trim();
      return out;
    }
    const ftMatch2 = work.match(
      /zeig(?:e)?\s+mir\s+(?:das\s+)?(?:projekt|repo|den\s+ordner|den\s+code)\s+(?:in|von|vom)?\s*(.+?)(?:\s+als)?\s*$/i
    );
    if (ftMatch2) {
      out.targetPath = ftMatch2[1].trim();
      return out;
    }
    return out;
  },

  // ── Path resolution ──────────────────────────────────────────

  _resolveExternalPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') {
      return { ok: false, error: 'Kein Pfad angegeben.' };
    }
    const home = os.homedir();
    const lower = rawPath.toLowerCase().trim();

    // Folder-alias resolution (matches the open-path handler's logic).
    const aliases = {
      'desktop': path.join(home, 'Desktop'),
      'documents': path.join(home, 'Documents'),
      'dokumente': path.join(home, 'Documents'),
      'downloads': path.join(home, 'Downloads'),
      'pictures': path.join(home, 'Pictures'),
      'bilder': path.join(home, 'Pictures'),
      'home': home,
    };
    let abs;
    if (aliases[lower]) {
      abs = aliases[lower];
    } else {
      // "github ordner auf dem desktop" pattern.
      const subAliasMatch = lower.match(/^(.+?)\s+ordner(?:\s+(?:auf|in|unter)\s+(?:dem|der)\s+(\w+))?$/i);
      if (subAliasMatch && subAliasMatch[2] && aliases[subAliasMatch[2]]) {
        abs = path.join(aliases[subAliasMatch[2]], subAliasMatch[1].trim());
      } else if (subAliasMatch && !subAliasMatch[2]) {
        // "X ordner" — try rootDir/X then desktop/X
        const candidate = subAliasMatch[1].trim();
        const tryPaths = [
          path.join(this.shell?._rootDir || process.cwd(), candidate),
          path.join(home, 'Desktop', candidate),
          path.join(home, 'Documents', candidate),
        ];
        abs = tryPaths.find(p => fs.existsSync(p)) || tryPaths[0];
      } else if (path.isAbsolute(rawPath)) {
        abs = rawPath;
      } else {
        // Relative — resolve from rootDir.
        abs = path.resolve(this.shell?._rootDir || process.cwd(), rawPath);
      }
    }

    if (!fs.existsSync(abs)) {
      return { ok: false, error: `Pfad nicht gefunden: ${abs}` };
    }
    if (!fs.statSync(abs).isDirectory()) {
      return { ok: false, error: `Pfad ist kein Verzeichnis: ${abs}` };
    }

    // 3-tier sandbox check.
    try {
      const Safety = require('../core/shell/ShellSafety');
      const trustLevel = (typeof this.trustLevelSystem?.getLevel === 'function')
        ? this.trustLevelSystem.getLevel() : 1;
      const fakeCmd = `ls "${abs}"`;
      const sandboxCheck = Safety.checkRootDirSandbox(fakeCmd,
        this.shell?._rootDir || process.cwd(),
        { platform: process.platform, trustLevel, settings: this.settings });
      if (!sandboxCheck.ok) {
        return { ok: false, error: `[SAFEGUARD] ${sandboxCheck.reason || 'path blocked'}` };
      }
    } catch (err) {
      _log.warn(`[ARCH] sandbox check skipped: ${err.message}`);
    }
    return { ok: true, absPath: abs };
  },

  // ── Genesis-self data collection ─────────────────────────────

  _collectGenesisData(selfModel, meta) {
    const byPhase = new Map();
    for (const [name, info] of Object.entries(meta)) {
      const phase = (info && typeof info.phase === 'number') ? info.phase : -1;
      if (!byPhase.has(phase)) byPhase.set(phase, []);
      byPhase.get(phase).push({ name, deps: info.deps || [], tags: info.tags || [] });
    }
    const phases = Array.from(byPhase.keys()).sort((a, b) =>
      a < 0 ? 1 : b < 0 ? -1 : a - b);
    return {
      kind: 'genesis',
      totalServices: Object.keys(meta).length,
      totalModules: typeof selfModel.moduleCount === 'function' ? selfModel.moduleCount() : null,
      byPhase, phases,
    };
  },

  // ── External-project data collection ────────────────────────

  async _collectExternalData(absPath) {
    const result = {
      kind: 'external',
      rootName: path.basename(absPath),
      absPath,
      manifests: [],
      topDirs: [],
      filesByLang: {},
      totalFiles: 0,
    };

    // Tier 1: known manifest files at the root.
    for (const [filename, readerKey] of Object.entries(_MANIFEST_READERS)) {
      const fullPath = path.join(absPath, filename);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const parsed = this[readerKey](fullPath);
        if (parsed) result.manifests.push(parsed);
      } catch (err) {
        _log.warn(`[ARCH] failed to read ${filename}: ${err.message}`);
      }
    }

    // Tier 2: top-level dirs + file-extension histogram.
    let entries;
    try { entries = fs.readdirSync(absPath, { withFileTypes: true }); }
    catch (err) { return { error: `Verzeichnis nicht lesbar: ${err.message}` }; }

    for (const e of entries) {
      if (e.isDirectory()) {
        if (_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        result.topDirs.push(e.name);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const lang = _LANG_BY_EXT[ext];
        if (lang) {
          result.filesByLang[lang] = (result.filesByLang[lang] || 0) + 1;
          result.totalFiles += 1;
        }
      }
    }
    // Walk one level deep into top-dirs for file counts.
    for (const dir of result.topDirs.slice(0, 10)) {
      try {
        const inner = fs.readdirSync(path.join(absPath, dir), { withFileTypes: true });
        for (const e of inner) {
          if (!e.isFile()) continue;
          const ext = path.extname(e.name).toLowerCase();
          const lang = _LANG_BY_EXT[ext];
          if (lang) {
            result.filesByLang[lang] = (result.filesByLang[lang] || 0) + 1;
            result.totalFiles += 1;
          }
        }
      } catch { /* skip unreadable subdirs */ }
    }
    return result;
  },

  // ── Manifest readers ─────────────────────────────────────────

  _readPackageJson(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      file: 'package.json', lang: 'JavaScript/Node',
      name: raw.name || null, version: raw.version || null,
      deps: Object.keys(raw.dependencies || {}),
      devDeps: Object.keys(raw.devDependencies || {}),
      scripts: Object.keys(raw.scripts || {}),
    };
  },

  _readRequirementsTxt(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const deps = text.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split(/[<>=!~\s]/)[0])
      .filter(Boolean);
    return { file: 'requirements.txt', lang: 'Python', deps, devDeps: [], scripts: [] };
  },

  _readPyproject(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const nameMatch = text.match(/^name\s*=\s*["']([^"']+)["']/m);
    const verMatch = text.match(/^version\s*=\s*["']([^"']+)["']/m);
    const depsMatch = text.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    const deps = depsMatch
      ? depsMatch[1].match(/["']([^"']+)["']/g)?.map(s => s.replace(/["']/g, '').split(/[<>=!~\s]/)[0]) || []
      : [];
    return {
      file: 'pyproject.toml', lang: 'Python',
      name: nameMatch?.[1] || null, version: verMatch?.[1] || null,
      deps, devDeps: [], scripts: [],
    };
  },

  _readGoMod(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const moduleMatch = text.match(/^module\s+(\S+)/m);
    const requireBlock = text.match(/require\s*\(([\s\S]*?)\)/);
    const deps = requireBlock
      ? requireBlock[1].split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean)
      : [];
    return {
      file: 'go.mod', lang: 'Go', name: moduleMatch?.[1] || null,
      version: null, deps, devDeps: [], scripts: [],
    };
  },

  _readCargoToml(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const nameMatch = text.match(/^\[package\][\s\S]*?^name\s*=\s*["']([^"']+)["']/m);
    const verMatch = text.match(/^\[package\][\s\S]*?^version\s*=\s*["']([^"']+)["']/m);
    const depsBlock = text.match(/^\[dependencies\]([\s\S]*?)(?=^\[|\Z)/m);
    const deps = depsBlock
      ? depsBlock[1].split('\n').map(l => l.match(/^([a-zA-Z0-9_-]+)\s*=/)?.[1]).filter(Boolean)
      : [];
    return {
      file: 'Cargo.toml', lang: 'Rust',
      name: nameMatch?.[1] || null, version: verMatch?.[1] || null,
      deps, devDeps: [], scripts: [],
    };
  },

  _readComposerJson(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      file: 'composer.json', lang: 'PHP/Composer',
      name: raw.name || null, version: raw.version || null,
      deps: Object.keys(raw.require || {}),
      devDeps: Object.keys(raw['require-dev'] || {}),
      scripts: Object.keys(raw.scripts || {}),
    };
  },

  // ── Renderers ────────────────────────────────────────────────

  _renderAsciiGenesis(data) {
    const lines = [];
    lines.push('═══ GENESIS — Architektur-Übersicht ═══');
    lines.push('');
    // Phase count consistent with README: phases 1-12 are the
    // architectural phases. Phase 0 is DI bootstrap infrastructure
    // (rootDir, bus, container, etc.) — counted in the boot but not
    // an architectural layer. We report the architectural count
    // and list Phase 0 separately for transparency.
    const architecturalPhases = data.phases.filter(p => p > 0);
    const hasBootstrap = data.phases.includes(0);
    lines.push(`${data.totalServices} Services über ${architecturalPhases.length} architektonische Phase(n)` +
      (hasBootstrap ? ` (+ Phase 0 Bootstrap)` : '') +
      (data.totalModules ? `  ·  ${data.totalModules} Source-Module` : ''));
    lines.push('');
    for (const phase of data.phases) {
      const services = data.byPhase.get(phase);
      const label = phase >= 0
        ? `Phase ${phase} — ${_PHASE_LABELS[phase] || 'Unknown'}`
        : 'Unphased';
      lines.push(`┌─ ${label} (${services.length})`);
      const visible = services.slice(0, 8);
      for (const svc of visible) {
        const depTag = svc.deps.length ? `  → ${svc.deps.slice(0, 3).join(', ')}${svc.deps.length > 3 ? '…' : ''}` : '';
        lines.push(`│  • ${svc.name}${depTag}`);
      }
      if (services.length > visible.length) {
        lines.push(`│  … +${services.length - visible.length} weitere`);
      }
      lines.push('└─');
    }
    return '```\n' + lines.join('\n') + '\n```';
  },

  _renderMermaidGenesis(data) {
    const lines = [];
    const _id = name => 'svc_' + name.replace(/[^a-zA-Z0-9]/g, '_');
    // Phase 0 (Bootstrap) is DI infrastructure — not in the
    // architectural diagram. Phases 1-12 match README's
    // "12-phase DI boot" claim.
    const renderablePhases = data.phases.filter(p => p > 0);
    // Tight cap: 3 services per phase keeps the diagram readable
    // when fitted to chat width. Full phase contents are in the
    // ASCII renderer (default).
    const MAX_SVCS_PER_PHASE = 3;
    const summary = `**Architektur-Übersicht** (deterministisch aus selfModel + manifest)\n\n` +
      `- ${data.totalServices} Services über ${renderablePhases.length} architektonische Phase(n) (Phase 0 = Bootstrap-Infrastruktur)\n` +
      (data.totalModules ? `- ${data.totalModules} Source-Module insgesamt\n` : '');
    // graph TB with directly-chained phase subgraphs. Each subgraph
    // gets a header node that the inter-phase arrow attaches to —
    // mermaid then stacks the subgraphs vertically and gives each
    // phase a clear vertical position. Inner direction LR keeps
    // service nodes side-by-side within a phase.
    lines.push('graph TB');
    const phaseHeaderIds = [];
    for (const phase of renderablePhases) {
      const services = data.byPhase.get(phase);
      const label = `Phase ${phase} — ${_PHASE_LABELS[phase] || 'Unknown'} (${services.length})`;
      const subgraphId = `p${phase}`;
      const headerId = `p${phase}_hdr`;
      phaseHeaderIds.push(headerId);
      lines.push(`  subgraph ${subgraphId}["${_escapeMermaid(label)}"]`);
      lines.push(`    direction LR`);
      // Header node — used as the endpoint for inter-phase arrows.
      // Visible because it carries the phase title; styled below.
      lines.push(`    ${headerId}["▸"]`);
      const visible = services.slice(0, MAX_SVCS_PER_PHASE);
      for (const svc of visible) {
        lines.push(`    ${_id(svc.name)}["${_escapeMermaid(svc.name)}"]`);
      }
      if (services.length > visible.length) {
        lines.push(`    more_p${phase}["+${services.length - visible.length} weitere"]`);
      }
      lines.push('  end');
    }
    // Visible phase-chain arrows (top phase → next → ...). These
    // give the eye a clear flow direction and force mermaid to
    // stack subgraphs vertically instead of side-by-side.
    for (let i = 0; i < phaseHeaderIds.length - 1; i++) {
      lines.push(`  ${phaseHeaderIds[i]} --> ${phaseHeaderIds[i + 1]}`);
    }
    // Style header nodes — small, dim, just enough to anchor arrows.
    for (const h of phaseHeaderIds) {
      lines.push(`  style ${h} fill:#2a2d38,stroke:#5b9dd6,color:#9aa0aa,stroke-width:1px`);
    }
    return summary + '\n```mermaid\n' + lines.join('\n') + '\n```';
  },

  _renderAsciiExternal(data) {
    const lines = [];
    lines.push(`═══ Projekt: ${data.rootName} ═══`);
    lines.push(`Pfad: ${data.absPath}`);
    lines.push('');
    if (data.manifests.length === 0 && Object.keys(data.filesByLang).length === 0) {
      lines.push('Keine bekannten Manifest-Dateien und keine erkennbaren Source-Files gefunden.');
      return '```\n' + lines.join('\n') + '\n```';
    }
    if (data.manifests.length > 0) {
      for (const m of data.manifests) {
        lines.push(`┌─ ${m.lang} — ${m.file}`);
        if (m.name) lines.push(`│  Projekt: ${m.name}${m.version ? ` v${m.version}` : ''}`);
        if (m.deps.length) {
          lines.push(`│  ${m.deps.length} dependencies:`);
          const visibleDeps = m.deps.slice(0, 10);
          for (const dep of visibleDeps) lines.push(`│    • ${dep}`);
          if (m.deps.length > visibleDeps.length) {
            lines.push(`│    … +${m.deps.length - visibleDeps.length} weitere`);
          }
        }
        if (m.devDeps && m.devDeps.length) {
          lines.push(`│  ${m.devDeps.length} dev-dependencies`);
        }
        if (m.scripts && m.scripts.length) {
          lines.push(`│  Scripts: ${m.scripts.slice(0, 5).join(', ')}${m.scripts.length > 5 ? '…' : ''}`);
        }
        lines.push('└─');
      }
    }
    if (data.topDirs.length > 0) {
      lines.push('');
      lines.push(`Top-Level-Ordner (${data.topDirs.length}):`);
      const visibleDirs = data.topDirs.slice(0, 12);
      for (const d of visibleDirs) lines.push(`  • ${d}/`);
      if (data.topDirs.length > visibleDirs.length) {
        lines.push(`  … +${data.topDirs.length - visibleDirs.length} weitere`);
      }
    }
    if (Object.keys(data.filesByLang).length > 0) {
      lines.push('');
      lines.push(`Source-Files (${data.totalFiles} insgesamt):`);
      const sorted = Object.entries(data.filesByLang)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of sorted) {
        lines.push(`  • ${lang}: ${count}`);
      }
    }
    return '```\n' + lines.join('\n') + '\n```';
  },

  _renderMermaidExternal(data) {
    const _id = s => 'n_' + s.replace(/[^a-zA-Z0-9]/g, '_');
    const lines = ['graph TD'];
    lines.push(`  root["${_escapeMermaid(data.rootName)}"]:::root`);
    if (data.manifests.length > 0) {
      for (const m of data.manifests) {
        const id = _id(m.file);
        const label = `${m.file}\\n(${m.deps.length} deps)`;
        lines.push(`  ${id}["${_escapeMermaid(label)}"]:::manifest`);
        lines.push(`  root --> ${id}`);
        // Show top deps as nodes too (cap at 8 for readability)
        const topDeps = m.deps.slice(0, 8);
        for (const dep of topDeps) {
          const depId = _id('dep_' + dep);
          lines.push(`  ${depId}["${_escapeMermaid(dep)}"]:::dep`);
          lines.push(`  ${id} --> ${depId}`);
        }
      }
    }
    if (data.topDirs.length > 0) {
      const dirsId = _id('dirs');
      const visibleDirs = data.topDirs.slice(0, 8);
      const dirLabel = visibleDirs.join('\\n');
      lines.push(`  ${dirsId}["${_escapeMermaid(dirLabel)}"]:::dirs`);
      lines.push(`  root --> ${dirsId}`);
    }
    lines.push('  classDef root fill:#324558,color:#fff;');
    lines.push('  classDef manifest fill:#2d6a4f,color:#fff;');
    lines.push('  classDef dep fill:#1f2230,color:#9fa8c0;');
    lines.push('  classDef dirs fill:#3a3f4d,color:#fff;');
    const summary = `**Projekt-Architektur**: ${data.rootName}\n` +
      `Pfad: \`${data.absPath}\`\n` +
      (data.manifests.length ? `${data.manifests.length} Manifest(s) · ` : '') +
      (data.topDirs.length ? `${data.topDirs.length} Top-Dirs · ` : '') +
      (data.totalFiles ? `${data.totalFiles} Source-Files\n` : '\n');
    return summary + '\n```mermaid\n' + lines.join('\n') + '\n```';
  },
};

function _escapeMermaid(s) {
  return String(s).replace(/["[\]<>]/g, '');
}

module.exports = { commandHandlersArchitecture: CommandHandlersArchitecture };
module.exports.commandHandlersArchitecture._PHASE_LABELS = _PHASE_LABELS;
module.exports.commandHandlersArchitecture._escapeMermaid = _escapeMermaid;
module.exports.commandHandlersArchitecture._LANG_BY_EXT = _LANG_BY_EXT;
module.exports.commandHandlersArchitecture._SKIP_DIRS = _SKIP_DIRS;
