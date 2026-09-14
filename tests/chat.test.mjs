import assert from 'node:assert/strict';
import test from 'node:test';
import { sendChatMessage } from '../src/lib/chat.ts';

test('chat stream survives split UTF-8, compact SSE data fields and an unterminated last line', async t => {
  const payload = 'data:{"choices":[{"delta":{"content":"你好"}}]}\r\n\ndata: {"choices":[{"delta":{"content":"，大师"}}]}';
  const bytes = new TextEncoder().encode(payload);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({start(c) {
    for (let i = 0; i < bytes.length; i += 2) c.enqueue(bytes.slice(i, i + 2));
    c.close();
  }})));
  let text = '';
  await sendChatMessage('https://example.test/chat', 'configured-model', [{role: 'user', content: '你好'}], chunk => text += chunk);
  assert.equal(text, '你好，大师');
});

test('service errors inside a successful streaming response are surfaced', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: {"error":{"message":"model unavailable"}}\n'));
  await assert.rejects(sendChatMessage('https://example.test/chat', 'missing-model', [], () => {}), /model unavailable/);
});

test('stop signal reaches the chat request', async t => {
  const ac = new AbortController(); ac.abort();
  t.mock.method(globalThis, 'fetch', async (_, options) => {assert.equal(options.signal, ac.signal); options.signal.throwIfAborted();});
  await assert.rejects(sendChatMessage('https://example.test/chat', 'model', [], () => {}, ac.signal), {name: 'AbortError'});
});
