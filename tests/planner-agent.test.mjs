import test from 'node:test';
import assert from 'node:assert/strict';
import {rankTier, previewRank} from '../src/lib/planner-agent.mjs';

test('the first three queue positions have distinct prominent colors', () => {
  assert.deepEqual([0, 1, 2, 3, 99].map(rankTier), [1, 2, 3, 'rest', 'rest']);
});

test('dragging a task to the top immediately gives it the first-position color', () => {
  assert.equal(rankTier(previewRank(3, {from: 3, to: 0})), 1);
  assert.equal(rankTier(previewRank(0, {from: 3, to: 0})), 2);
  assert.equal(rankTier(previewRank(1, {from: 3, to: 0})), 3);
  assert.equal(rankTier(previewRank(2, {from: 3, to: 0})), 'rest');
});

test('moving the first item down demotes its color before persistence resolves', () => {
  assert.equal(rankTier(previewRank(0, {from: 0, to: 2})), 3);
  assert.equal(rankTier(previewRank(1, {from: 0, to: 2})), 1);
  assert.equal(rankTier(previewRank(2, {from: 0, to: 2})), 2);
});
