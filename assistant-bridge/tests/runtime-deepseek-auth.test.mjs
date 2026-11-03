import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepseekFailure, safeDeepSeekModels, validateDeepSeekApiKey } from '../runtime/deepseek-auth.mjs';
import { createDeepSeekAdapter } from '../runtime/deepseek.mjs';

test('DeepSeek API key validation uses only the official read-only model endpoint', async () => {
  const key = 'offline-test-key-not-a-real-credential';
  const requests = [];
  const result = await validateDeepSeekApiKey(key, { fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', hiddenSecret: key }] }), { status: 200 });
  } });
  assert.equal(result.state, 'verified');
  assert.deepEqual(result.models, [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]);
  assert.equal(requests[0].url, 'https://api.deepseek.com/models');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${key}`);
  assert.equal(requests[0].options.redirect, 'manual');
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('DeepSeek validation distinguishes rejected credentials, outages, and malformed replies without exposing bodies', async () => {
  const secret = 'upstream-secret-must-not-escape';
  const scenarios = [
    { status: 401, body: secret, state: 'invalid', code: 'AUTHENTICATION' },
    { status: 403, body: secret, state: 'invalid', code: 'PERMISSION' },
    { status: 429, body: secret, state: 'unverified', code: 'RATE_LIMIT' },
    { status: 302, body: secret, state: 'unverified', code: 'NETWORK' },
    { status: 200, body: secret, state: 'unverified', code: 'RESPONSE_INVALID' },
    { status: 200, body: JSON.stringify({ data: [] }), state: 'unverified', code: 'RESPONSE_INVALID' },
  ];
  for (const row of scenarios) {
    const result = await validateDeepSeekApiKey('local-fixture', { fetchImpl: async () => new Response(row.body, { status: row.status }) });
    assert.equal(result.state, row.state);
    assert.equal(result.code, row.code);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const network = await validateDeepSeekApiKey('local-fixture', { fetchImpl: async () => { throw new Error(secret); } });
  assert.equal(network.state, 'unverified');
  assert.equal(network.code, 'NETWORK');
  assert.equal(JSON.stringify(network).includes(secret), false);
});

test('DeepSeek validates before transport, bounds responses, and strips unknown model fields', async () => {
  let called = false;
  const invalid = await validateDeepSeekApiKey('key\r\nInjected: header', { fetchImpl: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(invalid.code, 'INVALID_CREDENTIAL');
  const large = await validateDeepSeekApiKey('local-fixture', { fetchImpl: async () => new Response('x', { headers: { 'content-length': String(2 * 1024 * 1024) } }) });
  assert.equal(large.state, 'unverified');
  assert.deepEqual(safeDeepSeekModels([{ id: 'model1', name: 'Safe\nName', token: 'secret' }, { id: 'model1' }, { id: 'bad model' }, null]), [{ id: 'model1', name: 'SafeName' }]);
  assert.equal(deepseekFailure('arbitrary secret', 'Safe fallback'), 'Safe fallback');
});

function fixture(t, validator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-deepseek-auth-'));
  let config = {}, apiKey = 'saved-key-never-verified';
  const adapter = createDeepSeekAdapter({ projectRoot: root, toolsDir: path.join(root, 'tools'), dataDir: path.join(root, 'state'),
    getSecret: () => apiKey, setSecret: (_key, value) => { apiKey = value; },
    getConfig: () => structuredClone(config), setConfig: patch => { config = { ...config, ...patch }; },
    transportFactory: () => { throw new Error('This validation must not start a model runtime.'); }, apiKeyValidator: validator });
  t.after(async () => { await adapter.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { adapter, getConfig: () => config };
}

test('DeepSeek saving a nonempty key alone is not verified readiness', async t => {
  const { adapter } = fixture(t, async () => ({ state: 'invalid', code: 'AUTHENTICATION', models: [], message: '安全的认证失败提示' }));
  assert.equal((await adapter.status()).readiness, 'needs_validation');
  const result = await adapter.configure({ apiKey: 'rejected-key' });
  assert.equal(result.readiness, 'invalid_credentials');
  assert.equal(result.authentication.state, 'invalid');
  assert.equal(JSON.stringify(result).includes('rejected-key'), false);
});

test('DeepSeek a stale key verification cannot validate a replacement credential', async t => {
  let resolveOld;
  const { adapter, getConfig } = fixture(t, key => key === 'old-key' ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ state: 'invalid', code: 'AUTHENTICATION', models: [], message: '新密钥验证失败' }));
  const older = adapter.configure({ apiKey: 'old-key' });
  const newer = await adapter.configure({ apiKey: 'new-key' });
  assert.equal(newer.readiness, 'invalid_credentials');
  resolveOld({ state: 'verified', models: [{ id: 'deepseek-flash', name: 'Flash' }], message: '旧密钥验证成功' });
  await older;
  assert.equal((await adapter.status()).readiness, 'invalid_credentials');
  assert.equal(getConfig().apiKeyValidation.state, 'invalid');
});
