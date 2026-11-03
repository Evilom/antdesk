/** End-to-end OFFLINE account protocol verification with the installed official
 * runtime. Every platform/model endpoint is bound to this script's loopback
 * server and all account material is synthetic. No browser or real account.
 * Run from AntDesk root: node assistant-bridge/tests/deepseek-account-protocol-smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createDeepSeekAdapter, DEEPSEEK_DISABLED_PLUGINS } from '../runtime/deepseek.mjs';
import { createDeepSeekWebHost, DEEPSEEK_CLIENT_VERSION } from '../runtime/deepseek-host.mjs';
import { StdioRpc, isolatedRuntimeEnv } from '../runtime/stdio-rpc.mjs';

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const toolsDir = path.join(projectRoot, '.antdesk', 'runtime-tools');
const python = path.join(toolsDir, 'deepseek', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const qaRoot = path.join(projectRoot, '.antdesk', 'qa');
fs.mkdirSync(qaRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(qaRoot, 'deepseek-offline-account-'));
const home = path.join(dataDir, 'account-home');
const fixtureToken = `offline-local-fixture-${randomUUID()}`;
const user = { id: 'offline-test-user', email: 'offline@example.invalid', id_profile: { name: 'Offline QA', picture: null } };
const answer = '离线官方账号协议验证完成';
const requests = [];
let initiation, origin, stage = 'fixture-start', failed = false, rpc, host, adapter, pkceValidated = false, modelValidated = false;
const envelope = value => ({ code: 0, data: { biz_code: 0, biz_data: value } });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  requests.push({ path: url.pathname, method: req.method });
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) { res.writeHead(413).end(); return; } }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400).end(); return; }
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  const authenticated = () => req.headers['x-dsh-auth-token'] === fixtureToken && req.headers['x-api-key'] === undefined && req.headers.authorization === undefined;
  if (url.pathname === '/auth-api/v0/dsh/auth_init') {
    initiation = body;
    json(envelope({ authorize_url: `${origin}/dsh/authorize?authorize_id=offline`, authorize_id: 'offline', expires_in: 120 })); return;
  }
  if (url.pathname === '/auth-api/v0/dsh/auth_exchange') {
    pkceValidated = !!initiation && initiation.code_challenge_method === 'S256' && body.code === 'offline-code'
      && createHash('sha256').update(body.code_verifier || '').digest('base64url') === initiation.code_challenge
      && body.redirect_uri === initiation.redirect_uri;
    if (!pkceValidated) { res.writeHead(401).end(); return; }
    json(envelope({ token: fixtureToken, authorized_url: `${origin}/dsh/authorized`, user })); return;
  }
  if (url.pathname === '/auth-api/v0/users/current') {
    if (!authenticated()) { res.writeHead(401).end(); return; }
    json(envelope(user)); return;
  }
  if (url.pathname === '/models') {
    if (!authenticated()) { res.writeHead(401).end(); return; }
    json({ object: 'list', data: [{ id: 'deepseek-flash', name: 'Offline Official Account Fixture',
      context_window: 1000000, max_output_tokens: 1024, input_modalities: ['text'], output_modalities: ['text'],
      api_capabilities: { anthropic_messages: {} } }] }); return;
  }
  if (url.pathname === '/anthropic/v1/messages') {
    modelValidated = authenticated() && body.model === 'deepseek-flash'
      && (!body.tools || body.tools.length === 0) && body.dsh_session_log === undefined && body.dsh_plugin_packages === undefined;
    if (!modelValidated) { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'offline-message', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end(); return;
  }
  if (url.pathname.startsWith('/auth-api/')) { json(envelope({})); return; }
  res.writeHead(404).end();
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const accountConfig = { desktopPlatform: null, platformOrigin: origin, inferenceOrigin: origin, allowLoopbackHttp: true, requestTimeoutMs: 3000 };
  const llmConfig = { baseURL: `${origin}/anthropic`, modelsTimeoutMs: 3000, modelsMaxAgeMs: 0 };
  adapter = createDeepSeekAdapter({ projectRoot, dataDir, toolsDir, getSecret: () => undefined, setSecret: () => {},
    getConfig: () => ({ authMode: 'account' }), setConfig: () => {} });
  const webPatch = path.join(dataDir, 'offline-web.patch.json');
  fs.writeFileSync(webPatch, JSON.stringify([
    { id: 'session-log-deepseek', config: { enabled: false } }, { id: 'plugin-package-inventory-deepseek', disabled: true },
    { id: 'session-telemetry-otel', disabled: true }, { id: 'session-title-llm', disabled: true },
    { id: 'deepseek-account', config: accountConfig }, { id: 'llm-deepseek-account', config: llmConfig },
  ]));
  host = createDeepSeekWebHost({ python, home, patchPath: webPatch });
  stage = 'official-pkce-start';
  await host.open();
  const client = { version: DEEPSEEK_CLIENT_VERSION, locale: 'zh', timezoneOffsetSeconds: 0 };
  await host.call('account/startSignIn', { client, callbackOrigin: host.origin, loginSource: 'web' });
  let view;
  for (let n = 0; n < 120; n++) {
    view = await host.call('account/getState');
    if (view.attempt?.phase === 'waiting-browser') break;
    if (view.attempt?.phase === 'failed') throw new Error('Offline PKCE initialization failed.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(view?.attempt?.phase, 'waiting-browser');
  assert.ok(initiation);
  assert.equal(new URL(initiation.redirect_uri).origin, host.origin);
  stage = 'official-pkce-callback';
  const callback = new URL(initiation.redirect_uri);
  callback.searchParams.set('code', 'offline-code'); callback.searchParams.set('state', initiation.state);
  const received = await fetch(callback, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(received.status, 302);
  assert.equal(pkceValidated, true);
  assert.equal((await host.call('account/getState')).status, 'credential-stored');
  assert.equal((await host.call('account/getProfile', { client })).status, 'ready');
  const catalog = await host.call('session/modelCatalog');
  assert.ok(catalog.groups.find(group => group.id === 'deepseek-account')?.models.some(model => model.id === 'deepseek-flash'));

  stage = 'official-account-sdk-run';
  const patchPath = path.join(dataDir, 'account-sdk.patch.json');
  const patch = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const inserted = patch.find(row => row.insert).insert;
  inserted.find(row => row.id === 'deepseek-account').config = accountConfig;
  inserted.find(row => row.id === 'llm-deepseek-account').config = llmConfig;
  for (const id of DEEPSEEK_DISABLED_PLUGINS) assert.equal(patch.find(row => row.id === id)?.disabled, true);
  fs.writeFileSync(patchPath, JSON.stringify(patch));
  const cwd = path.join(dataDir, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
  rpc = new StdioRpc({ command: python,
    args: ['-I', '-X', 'utf8', '-u', path.join(projectRoot, 'assistant-bridge', 'runtime', 'python', 'deepseek_worker.py')],
    cwd, env: isolatedRuntimeEnv(home, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }), requestTimeoutMs: 45000 });
  await rpc.open();
  assert.equal((await rpc.call('initialize', { home, cwd, authMode: 'account', model: 'deepseek-flash', patchPath })).initialized, true);
  const result = await rpc.call('session/run', { sessionId: `antdesk-${randomUUID()}`, input: 'Offline test fixture: return the fixture response.' }, { timeoutMs: 20000 });
  assert.ok(['stop', 'completed', 'end_turn'].includes(result.finishReason));
  assert.equal(result.finalResponse, answer);
  assert.equal(modelValidated, true);
  await rpc.call('shutdown', {}, { timeoutMs: 6000 });
  stage = 'official-sign-out';
  assert.equal((await host.call('account/signOut', { client })).status, 'signed-out');
  console.log(JSON.stringify({ ok: true, officialRuntime: DEEPSEEK_CLIENT_VERSION, offline: true, pkceS256: true,
    sharedOfficialCredentialStore: true, accountModelHeader: true, toolsDisabled: true, uploadsDisabled: true,
    realAccountUsed: false, realModelCalled: false, response: answer }));
} catch (error) {
  failed = true;
  console.log(JSON.stringify({ ok: false, stage, offline: true, pkceValidated, modelValidated,
    code: typeof error?.code === 'string' && /^[A-Za-z_]+$/.test(error.code) ? error.code : undefined,
    workerError: typeof error?.data?.kind === 'string' ? error.data.kind : undefined,
    runtimeCode: typeof error?.data?.runtimeCode === 'string' ? error.data.runtimeCode : undefined,
    requestPaths: requests.map(request => request.path), realAccountUsed: false, realModelCalled: false }));
} finally {
  if (rpc) { try { await rpc.call('shutdown', {}, { timeoutMs: 6000 }); } catch {} await rpc.close(); }
  await host?.close(); await adapter?.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch { console.log(JSON.stringify({ cleanup: 'pending-file-lock', generatedDirectory: dataDir })); }
}
if (failed) process.exitCode = 1;
