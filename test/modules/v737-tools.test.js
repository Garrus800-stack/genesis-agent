// ============================================================
// v7.3.7 #9 — Memory Tools (mark-moment, journal-write,
//                            release-protected-memory)
//
// Verified:
//   registerV737Tools:
//     - No-op without toolRegistry
//     - Returns list of registered names
//     - Conditional registration: only tools with matching deps
//
//   mark-moment:
//     - Requires episodicMemory + pendingMomentsStore
//     - Uses getLatest() episode if available
//     - Falls back to _episodes[0] if no getLatest
//     - Returns ok:false if no episode exists
//     - Returns ok:false if pendingMomentsStore.mark returns null
//     - Uses input.summary, falls back to episode.topic
//
//   journal-write:
//     - Requires content string, rejects empty
//     - Default visibility 'shared'
//     - Custom tags array respected
//     - Returns ok:false on write failure
//
//   release-protected-memory:
//     - Requires coreMemoryId
//     - Returns ok:false if coreMemories.release returns false
//     - Uses reason 'genesis-decision' if none given
//     - Handles exceptions gracefully
// ============================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

const {
  registerV737Tools,
} = require('../../src/agent/cognitive/tools/v737-memory-tools');

// Minimal ToolRegistry mock
function makeToolRegistry() {
  const tools = new Map();
  return {
    register: (name, schema, handler, source) => {
      tools.set(name, { schema, handler, source });
    },
    _invoke: async (name, input) => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool: ${name}`);
      return await t.handler(input);
    },
    _get: (name) => tools.get(name),
    _has: (name) => tools.has(name),
    _all: () => [...tools.keys()],
  };
}

// ════════════════════════════════════════════════════════════
// registerV737Tools — registration behavior
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #9 — registerV737Tools', () => {

  it('returns empty array with null toolRegistry', () => {
    assert.deepStrictEqual(registerV737Tools(null, {}), []);
  });

  it('returns empty array with no register method', () => {
    assert.deepStrictEqual(registerV737Tools({}, {}), []);
  });

  it('registers all three tools when all deps present', () => {
    const reg = makeToolRegistry();
    const result = registerV737Tools(reg, {
      pendingMomentsStore: {},
      journalWriter: {},
      coreMemories: {},
      episodicMemory: {},
    });
    assert.strictEqual(result.length, 3);
    assert.ok(reg._has('mark-moment'));
    assert.ok(reg._has('journal-write'));
    assert.ok(reg._has('release-protected-memory'));
  });

  it('conditionally registers only tools with deps', () => {
    const reg = makeToolRegistry();
    registerV737Tools(reg, { journalWriter: {} });
    assert.ok(!reg._has('mark-moment'));
    assert.ok(reg._has('journal-write'));
    assert.ok(!reg._has('release-protected-memory'));
  });

  it('mark-moment needs BOTH pending + episodic', () => {
    const reg = makeToolRegistry();
    registerV737Tools(reg, { pendingMomentsStore: {} });
    assert.ok(!reg._has('mark-moment'));
    const reg2 = makeToolRegistry();
    registerV737Tools(reg2, { pendingMomentsStore: {}, episodicMemory: {} });
    assert.ok(reg2._has('mark-moment'));
  });

  it('tools are registered with v737-memory source tag', () => {
    const reg = makeToolRegistry();
    registerV737Tools(reg, {
      pendingMomentsStore: {}, journalWriter: {},
      coreMemories: {}, episodicMemory: {},
    });
    assert.strictEqual(reg._get('mark-moment').source, 'v737-memory');
    assert.strictEqual(reg._get('journal-write').source, 'v737-memory');
    assert.strictEqual(reg._get('release-protected-memory').source, 'v737-memory');
  });
});

// ════════════════════════════════════════════════════════════
// mark-moment
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #9 — mark-moment tool', () => {

  let reg, mockPending, mockEpisodic;
  beforeEach(() => {
    mockPending = {
      _marked: [],
      mark: ({ episodeId, summary, triggerContext }) => {
        const id = `pm_${mockPending._marked.length}`;
        mockPending._marked.push({ id, episodeId, summary, triggerContext });
        return id;
      },
    };
    mockEpisodic = {
      _latest: { id: 'ep_1', topic: 'Last Episode' },
      getLatest: () => mockEpisodic._latest,
    };
    reg = makeToolRegistry();
    registerV737Tools(reg, {
      pendingMomentsStore: mockPending,
      episodicMemory: mockEpisodic,
    });
  });

  it('pins latest episode with user summary', async () => {
    const r = await reg._invoke('mark-moment', { summary: 'this felt important' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.id, 'pm_0');
    assert.strictEqual(mockPending._marked[0].episodeId, 'ep_1');
    assert.strictEqual(mockPending._marked[0].summary, 'this felt important');
    assert.strictEqual(mockPending._marked[0].triggerContext, 'self-marked');
  });

  it('falls back to episode.topic if summary missing', async () => {
    const r = await reg._invoke('mark-moment', {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mockPending._marked[0].summary, 'Last Episode');
  });

  it('returns ok:false when no latest episode', async () => {
    mockEpisodic._latest = null;
    const r = await reg._invoke('mark-moment', { summary: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-latest-episode');
  });

  it('falls back to _episodes[0] when no getLatest method', async () => {
    const reg2 = makeToolRegistry();
    const em = { _episodes: [{ id: 'ep_x', topic: 't' }] };
    registerV737Tools(reg2, { pendingMomentsStore: mockPending, episodicMemory: em });
    const r = await reg2._invoke('mark-moment', {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mockPending._marked[mockPending._marked.length - 1].episodeId, 'ep_x');
  });

  it('returns ok:false when mark returns null', async () => {
    mockPending.mark = () => null;
    const r = await reg._invoke('mark-moment', { summary: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'mark-failed');
  });

  it('catches exceptions from mark', async () => {
    mockPending.mark = () => { throw new Error('boom'); };
    const r = await reg._invoke('mark-moment', { summary: 's' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'boom');
  });
});

// ════════════════════════════════════════════════════════════
// journal-write
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #9 — journal-write tool', () => {

  let reg, mockJournal;
  beforeEach(() => {
    mockJournal = {
      _writes: [],
      write: (entry) => {
        mockJournal._writes.push(entry);
        return { ...entry, ts: 'fake-ts' };
      },
    };
    reg = makeToolRegistry();
    registerV737Tools(reg, { journalWriter: mockJournal });
  });

  it('writes with default visibility shared', async () => {
    const r = await reg._invoke('journal-write', { content: 'hello' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mockJournal._writes[0].visibility, 'shared');
    assert.strictEqual(mockJournal._writes[0].source, 'genesis');
    assert.strictEqual(mockJournal._writes[0].content, 'hello');
  });

  it('honors explicit visibility and tags', async () => {
    const r = await reg._invoke('journal-write', {
      content: 'secret thought',
      visibility: 'private',
      tags: ['reflection'],
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mockJournal._writes[0].visibility, 'private');
    assert.deepStrictEqual(mockJournal._writes[0].tags, ['reflection']);
  });

  it('rejects empty content', async () => {
    const r = await reg._invoke('journal-write', { content: '' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'content-required');
  });

  it('rejects non-string content', async () => {
    const r = await reg._invoke('journal-write', { content: 123 });
    assert.strictEqual(r.ok, false);
  });

  it('returns ok:false when write returns null', async () => {
    mockJournal.write = () => null;
    const r = await reg._invoke('journal-write', { content: 'hi' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'write-failed');
  });

  it('catches exceptions from write', async () => {
    mockJournal.write = () => { throw new Error('disk full'); };
    const r = await reg._invoke('journal-write', { content: 'hi' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'disk full');
  });
});

// ════════════════════════════════════════════════════════════
// release-protected-memory
// ════════════════════════════════════════════════════════════

describe('v7.3.7 #9 — release-protected-memory tool', () => {

  let reg, mockCore;
  beforeEach(() => {
    mockCore = {
      _released: [],
      release: async (id, opts) => {
        mockCore._released.push({ id, ...opts });
        return true;
      },
    };
    reg = makeToolRegistry();
    registerV737Tools(reg, { coreMemories: mockCore });
  });

  it('releases protected memory with reason', async () => {
    const r = await reg._invoke('release-protected-memory', {
      coreMemoryId: 'cm_1',
      reason: 'obsolete now',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mockCore._released[0].id, 'cm_1');
    assert.strictEqual(mockCore._released[0].reason, 'obsolete now');
  });

  it('defaults reason to genesis-decision', async () => {
    await reg._invoke('release-protected-memory', { coreMemoryId: 'cm_1' });
    assert.strictEqual(mockCore._released[0].reason, 'genesis-decision');
  });

  it('rejects missing coreMemoryId', async () => {
    const r = await reg._invoke('release-protected-memory', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'coreMemoryId-required');
  });

  it('returns ok:false when release returns false', async () => {
    mockCore.release = async () => false;
    const r = await reg._invoke('release-protected-memory', { coreMemoryId: 'cm_nope' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-found-or-not-protected');
  });

  it('catches exceptions from release', async () => {
    mockCore.release = async () => { throw new Error('storage-fail'); };
    const r = await reg._invoke('release-protected-memory', { coreMemoryId: 'cm_1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'storage-fail');
  });
});
