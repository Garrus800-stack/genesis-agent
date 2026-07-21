#!/usr/bin/env node
// GENESIS — v7.9.43 W4: the graph fills its window; zoom survives resize.
'use strict';
const { describe, test, assert, run } = require('../harness');
const path = require('path'); const fs = require('fs');
const t = fs.readFileSync(path.resolve(__dirname,'..','..','src/ui/components/ArchitectureGraph.js'),'utf8');
describe('v7943 W4 — source pins', () => {
  test('no 600 cap: height follows the container', () => {
    assert(!/Math\.min\(600,[^)]*\)\s*\);\s*$/m.test(t.split('no 600 cap')[0]), 'old cap line replaced');
    assert(t.includes('clientHeight || 0) - 30'), 'container-driven height');
  });
  test('resize observer follows the window and re-renders, guarded', () => {
    assert(t.includes('new ResizeObserver'), 'observer present');
    assert(/this\._render\(\);?\s*\}\s*\}\s*catch/.test(t.replace(/\n/g,' ')), 're-render inside the guard');
    assert(t.includes('env without RO'), 'environments without RO stay safe');
  });
  test('zoom state is never reset by the observer', () => {
    const ro = t.split('new ResizeObserver')[1].split('observe(')[0];
    assert(!/zoom|scale\s*=|transform\s*=/.test(ro), 'observer touches size only');
  });
  test('svg height is 100 percent', () => {
    assert(t.includes("setAttribute('height', '100%')"), 'fills the modal');
  });
});
run();
