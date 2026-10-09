import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectRanges } from './index.mjs';

test('intersect half-open ranges, including containment and negative endpoints', () => {
  assert.deepEqual(intersectRanges([1, 5], [3, 7]), [3, 5]);
  assert.deepEqual(intersectRanges([-4, 4], [-2, 1]), [-2, 1]);
  assert.equal(intersectRanges([1, 2], [3, 4]), null);
});

test('touching endpoints and empty ranges have no intersection', () => {
  assert.equal(intersectRanges([1, 3], [3, 5]), null);
  assert.equal(intersectRanges([2, 2], [1, 4]), null);
});

test('reject malformed ranges on either side', () => {
  for (const value of [null, {}, '12', [], [1], [1, 2, 3], [3, 1], [NaN, 2], [0, Infinity], ['1', 2]]) {
    assert.throws(() => intersectRanges(value, [0, 4]), TypeError);
    assert.throws(() => intersectRanges([0, 4], value), TypeError);
  }
});

test('leave both inputs unchanged', () => {
  const a = Object.freeze([1, 5]);
  const b = Object.freeze([3, 7]);
  assert.deepEqual(intersectRanges(a, b), [3, 5]);
  assert.deepEqual(a, [1, 5]);
  assert.deepEqual(b, [3, 7]);
});
