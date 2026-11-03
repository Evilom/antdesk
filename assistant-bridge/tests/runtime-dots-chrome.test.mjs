import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDotsAdapter } from '../runtime/dots.mjs';
import { createChromeDotsFetch } from '../runtime/dots-chrome.mjs';

function responder() {
  const file = path.join(os.tmpdir(), `antdesk-dots-chrome-${process.pid}.mjs`);
  fs.writeFileSync(file, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\\n');
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    const headers = message.params?.headers || {};
    const names = Object.keys(headers).map(name => name.toLowerCase()).sort();
    if (names.some(name => name === 'cookie' || name === 'x-extra')) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'rejected', data: { code: 'invalid_endpoint' } } }) + '\\n');
      continue;
    }
    const status = message.params?.url?.includes('redirect') ? 302 : 200;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      status, headers: { 'content-type': 'application/json', 'cf-mitigated': status === 200 ? 'challenge' : '' },
      body: JSON.stringify({ items: [{ id: 'dot-1', display_name: 'omdot', status: 'active', messaging_room_id: 'room-1' }], cursor: null, names }),
    } }) + '\\n');
  }
});
`);
  return file;
}

test('the browser client rejects other origins before a token can leave the process', async () => {
  let spawned = 0;
  const browser = createChromeDotsFetch({ browserCommand: 'unused', spawnProcess: () => { spawned++; throw new Error('spawned'); } });
  await assert.rejects(browser.fetch('https://example.test/backend-api/tbo', { headers: { Authorization: 'Bearer secret' } }), { code: 'invalid_endpoint' });
  await assert.rejects(browser.fetch('http://chatgpt.com/backend-api/tbo'), { code: 'invalid_endpoint' });
  await assert.rejects(browser.fetch('https://chatgpt.com.evil/backend-api/tbo'), { code: 'invalid_endpoint' });
  assert.equal(spawned, 0);
  await browser.close();
});

test('direct Dots requests go through the Chrome client and drop unlisted headers', async () => {
  const file = responder();
  const browser = createChromeDotsFetch({ browserCommand: process.execPath, browserArgs: [file], spawnProcess: spawn });
  const response = await browser.fetch('https://chatgpt.com/backend-api/tbo?limit=1', {
    method: 'GET', headers: { Authorization: 'Bearer secret', 'ChatGPT-Account-ID': 'account', Cookie: 'session=secret', 'X-Extra': 'no' },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cf-mitigated'), 'challenge');
  assert.deepEqual(body.names, ['authorization', 'chatgpt-account-id']);
  const redirected = browser.fetch('https://chatgpt.com/backend-api/tbo?redirect=1', { method: 'GET', headers: { Authorization: 'Bearer secret' } });
  await assert.rejects(redirected, { code: 'dots_redirect' });
  await browser.close();
  fs.unlinkSync(file);
});

test('an adapter without a fetch override uses the Chrome client for the saved account', async () => {
  const file = responder();
  const adapter = createDotsAdapter({
    getAuth: async () => ({ token: 'saved-account-token', accountId: 'chrome-account', userId: 'chrome-user' }),
    browserCommand: process.execPath, browserArgs: [file], spawnProcess: spawn,
  });
  const state = await adapter.status();
  assert.equal(state.readiness, 'ready');
  assert.match(state.message, /原 Dots 目录已验证/);
  const agents = await adapter.agents();
  assert.equal(agents.agents[0].id, 'dot-1');
  assert.equal(agents.agents[0].name, 'omdot');
  await adapter.close();
  fs.unlinkSync(file);
});

test('a missing browser component is reported without searching another Codex login', async () => {
  const adapter = createDotsAdapter({
    toolsDir: path.join(os.tmpdir(), 'antdesk-missing-dots-browser'),
    getAuth: async () => ({ token: 'saved-account-token', accountId: 'chrome-account', userId: 'chrome-user' }),
  });
  const state = await adapter.status();
  assert.equal(state.reason, 'runtime_missing');
  assert.match(state.message, /浏览器组件尚未安装/);
  await adapter.close();
});

test('the pinned Chrome worker rejects every non-dots destination', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const python = path.join(root, '.antdesk', 'runtime-tools', 'muse-personal', 'venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) return;
  const script = path.join(root, 'assistant-bridge', 'runtime', 'python', 'dots_chrome_fetch.py');
  const child = spawn(python, ['-I', '-X', 'utf8', '-u', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const requests = [
    ['https://example.test/backend-api/tbo', 'GET'],
    ['http://chatgpt.com/backend-api/tbo', 'GET'],
    ['https://chatgpt.com.evil/backend-api/tbo', 'GET'],
    ['https://chatgpt.com/backend-api/tbo', 'PUT'],
    ['https://user:secret@chatgpt.com/backend-api/tbo', 'GET'],
  ];
  requests.forEach((item, index) => child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: index + 1, method: 'fetch',
    params: { url: item[0], method: item[1], headers: { Authorization: 'Bearer secret', 'ChatGPT-Account-ID': 'account' } },
  }) + '\n'));
  child.stdin.end();
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0);
  const lines = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, requests.length);
  assert.ok(lines.every(line => line.error?.data?.code === 'invalid_endpoint'));
  assert.ok(!output.includes('secret'));
});
