// ============================================================
// GENESIS — v7920-embedding-probe-selection.test.js
// Facet 11: harden embedding model selection + boot probe.
// Stubs the HTTP layer (no Ollama needed). Verifies:
//   1. exact preferred match beats a substring-only match (and is
//      independent of /api/tags ordering); stripped names de-duplicated
//   2. candidate failover: first candidate fails, next one is tried
//   3. boot probe uses EMBEDDING_PROBE timeout and a CPU (num_gpu:0)
//      last-resort on failure; steady-state embed() does NEITHER
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { EmbeddingService } = require('../../src/agent/foundation/EmbeddingService');
const { TIMEOUTS } = require('../../src/agent/core/Constants');

const bus = { emit() {}, fire() {} };
const tags = (...names) => ({ models: names.map(n => ({ name: n })) });
const isCpu = (body) => {
  try { return JSON.parse(body)?.options?.num_gpu === 0; } catch { return false; }
};
const modelOf = (body) => { try { return JSON.parse(body)?.model; } catch { return null; } };

describe('v7920 embedding probe + selection', () => {

  test('exact preferred match wins over substring-only, regardless of tag order', async () => {
    const es = new EmbeddingService({ bus });
    const probed = [];
    es._httpGet = async () => tags('nomic-embed-text-v2-moe:latest', 'nomic-embed-text:latest');
    es._httpPost = async (_url, body) => { probed.push(modelOf(body)); return { embedding: [1, 2, 3, 4] }; };
    await es.init();
    assert(es.available, 'should become available');
    assertEqual(es.model, 'nomic-embed-text', 'exact v1 must be chosen, not v2-moe');
    assertEqual(probed[0], 'nomic-embed-text', 'exact v1 must be the first candidate probed');
    assertEqual(es.dimensions, 4, 'dimensions from probe vector');
  });

  test('stripped names are de-duplicated (same model not probed twice)', async () => {
    const es = new EmbeddingService({ bus });
    const probed = [];
    es._httpGet = async () => tags('nomic-embed-text:latest', 'nomic-embed-text:v1.5');
    es._httpPost = async (_url, body) => { probed.push(modelOf(body)); return { embedding: [0.1, 0.2] }; };
    await es.init();
    assertEqual(es.model, 'nomic-embed-text', 'chosen model');
    assertEqual(probed.length, 1, 'de-duplicated: exactly one probe, not two');
  });

  test('failover: first candidate fails, second is tried and wins', async () => {
    const es = new EmbeddingService({ bus });
    const probed = [];
    es._httpGet = async () => tags('nomic-embed-text:latest', 'mxbai-embed-large:latest');
    es._httpPost = async (_url, body) => {
      const m = modelOf(body);
      probed.push(m);
      if (m === 'nomic-embed-text') throw new Error('Timeout');
      return { embedding: [9, 9, 9] };
    };
    await es.init();
    assert(es.available, 'should fail over to a working model');
    assertEqual(es.model, 'mxbai-embed-large', 'second candidate chosen after first fails');
    assert(probed.includes('nomic-embed-text'), 'first candidate was attempted');
    assertEqual(es.dimensions, 3, 'dimensions from the working model');
  });

  test('all candidates fail -> not available, model reset to null (TF-IDF fallback)', async () => {
    const es = new EmbeddingService({ bus });
    es._httpGet = async () => tags('nomic-embed-text:latest');
    es._httpPost = async () => { throw new Error('Timeout'); };
    await es.init();
    assert(!es.available, 'must stay unavailable when nothing works');
    assertEqual(es.model, null, 'model reset to null so embed()/getStats() do not lie');
    assertEqual(await es.embed('x'), null, 'embed() returns null when unavailable');
  });

  test('boot probe: CPU last-resort fires on timeout; steady-state embed() does not', async () => {
    const es = new EmbeddingService({ bus });
    let gpuCalls = 0, cpuCalls = 0;
    const timeouts = [];
    es._httpGet = async () => tags('nomic-embed-text:latest');
    es._httpPost = async (_url, body, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (isCpu(body)) { cpuCalls++; return { embedding: [5, 6] }; }
      gpuCalls++; throw new Error('Timeout');
    };
    await es.init();
    assert(es.available, 'boot probe should recover via CPU last-resort');
    assertEqual(es.dimensions, 2, 'dimensions from CPU last-resort');
    assert(cpuCalls >= 1, 'CPU last-resort used during boot probe');
    assert(timeouts.includes(TIMEOUTS.EMBEDDING_PROBE), 'boot probe uses EMBEDDING_PROBE timeout');

    gpuCalls = 0; cpuCalls = 0; timeouts.length = 0;
    const vec = await es.embed('hello steady state');
    assertEqual(vec, null, 'steady-state embed() returns null on a warm timeout');
    assertEqual(cpuCalls, 0, 'steady-state must NOT do a CPU retry on timeout');
    assertEqual(gpuCalls, 1, 'steady-state made exactly one (GPU) attempt');
    assert(!timeouts.includes(TIMEOUTS.EMBEDDING_PROBE), 'steady-state must not use the probe timeout');
  });

});

if (require.main === module) run();
