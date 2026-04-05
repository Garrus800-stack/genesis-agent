const { describe, test, run } = require('../harness');
const os = require('os'), path = require('path'), fs = require('fs');
let ConversationMemory;
try { ConversationMemory = require('../../src/agent/foundation/ConversationMemory').ConversationMemory; } catch (_e) {}
function make() {
  if (!ConversationMemory) return null;
  const d = path.join(os.tmpdir(), 'cm-test-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  return new ConversationMemory(d, { emit(){}, on(){} }, { readJSON: ()=>null, writeJSON: ()=>{}, writeJSONDebounced: ()=>{} });
}
describe('ConversationMemory', () => {
  test('module loads', () => { if (!ConversationMemory) throw new Error('Failed to load'); });
  test('constructs', () => { if (!make()) throw new Error('Fail'); });
  test('addEpisode and buildContext', () => {
    const cm = make(); if (!cm) return;
    cm.addEpisode([{ role: 'user', content: 'hello' }], 'greeting');
    const ctx = cm.buildContext('hello');
    if (typeof ctx !== 'string') throw new Error('Should return string');
  });
});
if (require.main === module) run();
