import assert from 'node:assert/strict';
import test from 'node:test';
import { positionBetween } from '../lib/kanban-order.js';
test('empty columns, prepends, appends and repeated insertion use ordered positions', () => {
  assert.equal(positionBetween(), 0);
  assert.equal(positionBetween(undefined, 0), -1);
  assert.equal(positionBetween(10), 11);
  let after = 1;
  for (let n = 0; n < 30; n++) {
    const position = positionBetween(0, after);
    assert.ok(position > 0 && position < after);
    after = position;
  }
});
