#!/usr/bin/env node
// Test: ConsciousnessState.js — Finite State Machine
const { describe, test, assert, assertEqual, run } = require('../harness');
const ConsciousnessState = require('../../src/agent/consciousness/ConsciousnessState');

describe('ConsciousnessState — Initialization', () => {
  test('starts in AWAKE state', () => {
    const cs = new ConsciousnessState();
    assertEqual(cs.current, 'AWAKE');
    assertEqual(cs.previous, null);
  });
});

describe('ConsciousnessState — Valid Transitions', () => {
  test('AWAKE → DAYDREAM is valid', () => {
    const cs = new ConsciousnessState();
    assert(cs.transition('DAYDREAM'), 'should allow AWAKE→DAYDREAM');
    assertEqual(cs.current, 'DAYDREAM');
    assertEqual(cs.previous, 'AWAKE');
  });

  test('AWAKE → DEEP_SLEEP is valid', () => {
    const cs = new ConsciousnessState();
    assert(cs.transition('DEEP_SLEEP'));
    assertEqual(cs.current, 'DEEP_SLEEP');
  });

  test('AWAKE → HYPERVIGILANT is valid', () => {
    const cs = new ConsciousnessState();
    assert(cs.transition('HYPERVIGILANT'));
    assertEqual(cs.current, 'HYPERVIGILANT');
  });

  test('DAYDREAM → AWAKE is valid', () => {
    const cs = new ConsciousnessState();
    cs.transition('DAYDREAM');
    assert(cs.transition('AWAKE'));
    assertEqual(cs.current, 'AWAKE');
  });

  test('DEEP_SLEEP → AWAKE is valid', () => {
    const cs = new ConsciousnessState();
    cs.transition('DEEP_SLEEP');
    assert(cs.transition('AWAKE'));
  });

  test('HYPERVIGILANT → AWAKE is valid', () => {
    const cs = new ConsciousnessState();
    cs.transition('HYPERVIGILANT');
    assert(cs.transition('AWAKE'));
  });
});

describe('ConsciousnessState — Invalid Transitions', () => {
  test('DAYDREAM → HYPERVIGILANT is invalid', () => {
    const cs = new ConsciousnessState();
    cs.transition('DAYDREAM');
    assert(!cs.transition('HYPERVIGILANT'), 'should reject DAYDREAM→HYPERVIGILANT');
    assertEqual(cs.current, 'DAYDREAM', 'state unchanged');
  });

  test('DEEP_SLEEP → DAYDREAM is invalid', () => {
    const cs = new ConsciousnessState();
    cs.transition('DEEP_SLEEP');
    assert(!cs.transition('DAYDREAM'));
  });

  test('HYPERVIGILANT → DEEP_SLEEP is invalid', () => {
    const cs = new ConsciousnessState();
    cs.transition('HYPERVIGILANT');
    assert(!cs.transition('DEEP_SLEEP'));
  });

  test('unknown state is rejected', () => {
    const cs = new ConsciousnessState();
    assert(!cs.transition('INVALID_STATE'));
    assertEqual(cs.current, 'AWAKE');
  });

  test('same-state transition is idempotent', () => {
    const cs = new ConsciousnessState();
    assert(cs.transition('AWAKE'), 'AWAKE→AWAKE should be idempotent (returns true)');
    assertEqual(cs.current, 'AWAKE');
  });
});

describe('ConsciousnessState — History', () => {
  test('records transition history', () => {
    const cs = new ConsciousnessState();
    cs.transition('DAYDREAM');
    cs.transition('AWAKE');
    cs.transition('HYPERVIGILANT');
    assert(cs._history.length >= 3, 'should have 3 history entries');
  });

  test('enteredAt updates on transition', () => {
    const cs = new ConsciousnessState();
    const t1 = cs.enteredAt;
    cs.transition('DAYDREAM');
    assert(cs.enteredAt >= t1, 'enteredAt should be updated');
  });
});

run();
