import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectNotionPages} from '../src/lib/notion-pagination.mjs';

test('reads all pages in source order, passing the exact cursor and removing overlap', async () => {
  const calls = [];
  const result = await collectNotionPages(async cursor => {
    calls.push(cursor);
    if (!cursor) return {results: Array.from({length: 100}, (_, index) => ({id: String(index)})), has_more: true, next_cursor: 'second'};
    return {results: [{id: '99'}, {id: '100'}], has_more: false, next_cursor: null};
  });
  assert.deepEqual(calls, [undefined, 'second']);
  assert.equal(result.length, 101);
  assert.equal(result.at(-1).id, '100');
});

test('a later page failure rejects the whole sync instead of publishing partial results', async () => {
  let cache = [{id: 'old'}];
  await assert.rejects(async () => {
    cache = await collectNotionPages(async cursor => {
      if (!cursor) return {results: [{id: 'new'}], has_more: true, next_cursor: 'second'};
      throw new Error('rate limited');
    });
  }, /rate limited/);
  assert.deepEqual(cache, [{id: 'old'}]);
});

test('repeated cursors and empty next cursors fail immediately', async () => {
  let count = 0;
  await assert.rejects(collectNotionPages(async () => {
    count++;
    return {results: [], has_more: true, next_cursor: 'same'};
  }), /游标/);
  assert.equal(count, 2);
  await assert.rejects(collectNotionPages(async () => ({results: [], has_more: true, next_cursor: null})), /游标/);
});

test('malformed response does not silently replace valid cached data with an empty list', async () => {
  await assert.rejects(collectNotionPages(async () => ({object: 'error', message: 'unauthorized'})), /无效/);
  await assert.rejects(collectNotionPages(async () => ({results: [], has_more: 'false'})), /无效/);
  assert.deepEqual(await collectNotionPages(async () => ({results: [], has_more: false})), []);
});
