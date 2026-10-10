import assert from 'node:assert/strict';
import test from 'node:test';
import { positionBetween, keyboardTaskStep } from '../lib/kanban-order.js';
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
test('keyboard moves choose logical columns and ordering independently of screen geometry', () => {
  const columns = [{id:'todo'},{id:'progress'},{id:'done'}];
  const cards = [{id:'a',columnId:'todo',position:0},{id:'b',columnId:'todo',position:1},{id:'c',columnId:'todo',position:2}];
  const down = keyboardTaskStep(cards,columns,'a','ArrowDown')!;
  assert.ok(down.cards[0].position > 1 && down.cards[0].position < 2);
  const up = keyboardTaskStep(down.cards,columns,'a','ArrowUp')!;
  assert.ok(up.cards[0].position < 1);
  const right = keyboardTaskStep(cards,columns,'a','ArrowRight')!;
  assert.equal(right.columnId, 'progress'); assert.equal(right.targetId, 'progress');
  assert.deepEqual(right.cards[0], {id:'a',columnId:'progress',position:0});
  const again = keyboardTaskStep(right.cards,columns,'a','ArrowRight')!;
  assert.equal(again.columnId,'done');
  assert.equal(keyboardTaskStep(again.cards,columns,'a','ArrowRight'), null);
  assert.equal(keyboardTaskStep(cards,columns,'a','Escape'), null);
  assert.equal(cards[0].columnId,'todo');
});
