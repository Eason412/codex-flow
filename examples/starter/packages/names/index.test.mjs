import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNames } from './index.mjs';

test('trim, discard blanks, and retain the first spelling in input order', () => {
  assert.deepEqual(normalizeNames([' Bob ', '', 'alice', 'bob', ' ALICE ']), ['Bob', 'alice']);
  assert.deepEqual(normalizeNames([]), []);
});

test('reject invalid inputs, including an empty non-array value', () => {
  for (const value of [null, {}, 'abc', 1, new Set(), [3], ['ok', null]]) {
    assert.throws(() => normalizeNames(value), TypeError);
  }
});

test('leave the input unchanged', () => {
  const values = Object.freeze([' A ', 'a', ' ']);
  assert.deepEqual(normalizeNames(values), ['A']);
  assert.deepEqual(values, [' A ', 'a', ' ']);
});
