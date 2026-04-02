// ============================================================
// GENESIS — test/modules/logger.test.js (v4.10.0)
//
// Tests for Logger dual-mode output (human + JSON) and sink API.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { Logger, createLogger } = require('../../src/agent/core/Logger');

describe('Logger — Human Mode (default)', () => {
  test('createLogger returns Logger instance', () => {
    const log = createLogger('TestModule');
    assert(log instanceof Logger);
    assertEqual(log.module, 'TestModule');
  });

  test('default format is human', () => {
    Logger.setFormat('human'); // ensure reset
    assertEqual(Logger.getFormat(), 'human');
  });

  test('default level is info', () => {
    Logger.setLevel('info');
    assertEqual(Logger.getLevel(), 'info');
  });

  test('level filtering works', () => {
    const entries = [];
    Logger.setSink((e) => entries.push(e));
    Logger.setLevel('warn');
    Logger.setFormat('human');

    const log = createLogger('FilterTest');
    log.debug('should not appear');
    log.info('should not appear');
    log.warn('should appear');
    log.error('should appear');

    assertEqual(entries.length, 2);
    assertEqual(entries[0].level, 'warn');
    assertEqual(entries[1].level, 'error');

    Logger.setSink(null);
    Logger.setLevel('info');
  });
});

describe('Logger — JSON Mode', () => {
  test('setFormat switches to json', () => {
    Logger.setFormat('json');
    assertEqual(Logger.getFormat(), 'json');
    Logger.setFormat('human');
  });

  test('json mode produces structured entries via sink', () => {
    const entries = [];
    Logger.setSink((e) => entries.push(e));
    Logger.setFormat('json');
    Logger.setLevel('debug');

    const log = createLogger('JsonTest');
    log.info('hello world');

    assert(entries.length >= 1, 'Expected at least 1 entry');
    const e = entries[0];
    assertEqual(e.format, 'json');
    assertEqual(e.level, 'info');
    assertEqual(e.module, 'JsonTest');
    assert(e.entry.ts, 'Expected timestamp');
    assertEqual(e.entry.msg, 'hello world');

    Logger.setSink(null);
    Logger.setFormat('human');
    Logger.setLevel('info');
  });

  test('json mode handles objects in args', () => {
    const entries = [];
    Logger.setSink((e) => entries.push(e));
    Logger.setFormat('json');

    const log = createLogger('ObjTest');
    log.info('result:', { count: 42, ok: true });

    const e = entries[0];
    assertEqual(e.format, 'json');
    // Multi-arg: msg is array
    assert(Array.isArray(e.entry.msg), 'Expected array for multi-arg');
    assertEqual(e.entry.msg[0], 'result:');
    assertEqual(e.entry.msg[1].count, 42);

    Logger.setSink(null);
    Logger.setFormat('human');
  });

  test('json mode handles Error objects', () => {
    const entries = [];
    Logger.setSink((e) => entries.push(e));
    Logger.setFormat('json');

    const log = createLogger('ErrTest');
    log.error('failed:', new Error('test error'));

    const e = entries[0];
    assert(Array.isArray(e.entry.msg));
    assertEqual(e.entry.msg[1].error, 'test error');
    assert(e.entry.msg[1].stack, 'Expected stack trace');

    Logger.setSink(null);
    Logger.setFormat('human');
  });
});

describe('Logger — Sink API', () => {
  test('sink receives all log calls', () => {
    const entries = [];
    Logger.setSink((e) => entries.push(e));
    Logger.setFormat('human');
    Logger.setLevel('debug');

    const log = createLogger('SinkTest');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    assertEqual(entries.length, 4);
    assertEqual(entries[0].level, 'debug');
    assertEqual(entries[3].level, 'error');

    Logger.setSink(null);
    Logger.setLevel('info');
  });

  test('null sink disables capture', () => {
    Logger.setSink(null);
    const log = createLogger('NullSink');
    // Should not throw
    log.info('this goes to console only');
  });

  test('invalid sink is ignored', () => {
    Logger.setSink('not a function');
    const log = createLogger('BadSink');
    log.info('should not throw');
    Logger.setSink(null);
  });
});

run();
