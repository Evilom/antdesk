import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDotsAuth, codexAuthEnvironment, codexHomesMatch } from '../runtime/dots-auth.mjs';
import { createDotsClient } from '../runtime/dots.mjs';

const jwt = (claims, subject) => [Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': claims, ...(subject === undefined ? {} : { sub: subject }) })).toString('base64url'), 'offline-signature'].join('.');
const token = jwt({ chatgpt_account_id: 'account-owned', chatgpt_user_id: 'user-owned', email: 'private@example.invalid' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { for (let count = 0; count < 200; count++) { if (predicate()) return; await nextTurn(); } assert.fail('Expected authentication action did not begin.'); }

function fixture(t, behavior = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-dots-auth-'));
  const dataDir = path.join(root, 'provider'), transports = [], calls = [];
  const state = { account: behavior.signedIn ? { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' } : null,
    authMethod: 'chatgpt', token, workspaceRouting: null, loginSequence: 0 };
  class Rpc extends EventEmitter {
    constructor(settings) { super(); this.settings = settings; this.closed = false; this.pending = new Set(); transports.push(this); }
    async open() {}
    async call(method, params) {
      if (this.closed) throw new Error('Closed');
      calls.push({ method, params });
      const operation = (async () => {
        const custom = await behavior.handle?.(method, params, this, state);
        if (custom !== undefined) return custom;
        if (method === 'initialize') return { codexHome: this.settings.env.CODEX_HOME, platformFamily: 'test', platformOs: 'test', userAgent: 'codex-test' };
        if (method === 'account/read') return { account: state.account, requiresOpenaiAuth: true, workspaceRouting: state.workspaceRouting };
        if (method === 'getAuthStatus') return { authMethod: state.account ? state.authMethod : null, authToken: state.account ? state.token : null, requiresOpenaiAuth: true };
        if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-' + ++state.loginSequence,
          authUrl: 'https://auth.openai.com/oauth/authorize?state=offline-state&code_challenge=offline-challenge' };
        if (method === 'account/login/cancel') return { status: 'canceled' };
        if (method === 'account/logout') { state.account = null; return {}; }
        assert.fail('Unexpected RPC method: ' + method);
      })();
      const closing = deferred(); this.pending.add(closing);
      try { return await Promise.race([operation, closing.promise]); } finally { this.pending.delete(closing); }
    }
    async notify(method, params) { calls.push({ method, params }); }
    async close() {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending) pending.reject(new Error('Closed'));
      this.emit('disconnect');
    }
  }
  const auth = createDotsAuth({ dataDir, toolsDir: path.join(root, 'tools'), transportFactory: settings => new Rpc(settings), ...behavior.options });
  t.after(async () => { await auth.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { auth, state, root, dataDir, calls, transports,
    signIn() { state.account = { type: 'chatgpt', email: 'private@example.invalid', planType: 'pro' }; },
    notify(method, params) { transports.at(-1).emit('notification', method, params); } };
}

test('Dots child environment has its own home and cannot inherit current account or model credentials', () => {
  const env = codexAuthEnvironment('/owned/profile', { PATH: '/system/bin', HOME: '/foreign/home', CODEX_HOME: '/foreign/codex',
    CODEX_ACCESS_TOKEN: 'foreign-access', OPENAI_API_KEY: 'foreign-key', CHATGPT_TOKEN: 'foreign-session',
    AWS_SECRET_ACCESS_KEY: 'foreign-aws', MUSE_AUTH_PATH: '/foreign/muse', HTTPS_PROXY: 'http://local-proxy:8080' });
  assert.equal(env.HOME, '/owned/profile'); assert.equal(env.CODEX_HOME, '/owned/profile');
  assert.equal(env.USERPROFILE, '/owned/profile'); assert.equal(env.HTTPS_PROXY, 'http://local-proxy:8080');
  assert.equal(JSON.stringify(env).includes('foreign'), false);
});

test('Windows extended drive and UNC paths still require exactly the owned Codex directory', () => {
  assert.equal(codexHomesMatch('\\\\?\\D:\\projects\\antdesk\\profile', 'd:\\projects\\antdesk\\profile', 'win32'), true);
  assert.equal(codexHomesMatch('\\\\?\\UNC\\server\\share\\profile', '\\\\server\\share\\profile', 'win32'), true);
  assert.equal(codexHomesMatch('\\\\?\\D:\\projects\\antdesk\\profile-other', 'D:\\projects\\antdesk\\profile', 'win32'), false);
});

test('passive Dots status starts only an owned official auth host and never starts login or a task', async t => {
  const f = fixture(t);
  assert.equal(f.transports.length, 0);
  const result = await f.auth.status();
  assert.equal(result.readiness, 'needs_login'); assert.equal(await f.auth.getAuth(), null);
  const rpc = f.transports[0];
  assert.deepEqual(rpc.settings.args, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"']);
  assert.equal(rpc.settings.env.CODEX_HOME, path.join(f.dataDir, 'codex-profile'));
  assert.equal(rpc.settings.cwd, rpc.settings.env.CODEX_HOME);
  assert.deepEqual(f.calls[0], { method: 'initialize', params: { clientInfo: { name: 'antdesk', title: 'AntDesk', version: '2.19.5' }, capabilities: { experimentalApi: true } } });
  assert.equal(f.calls[1].method, 'initialized');
  assert.equal(f.calls.some(call => /login\/start|turn\/|thread\//.test(call.method)), false);
});

test('a host reporting a foreign CODEX_HOME is closed before any account or token read', async t => {
  const f = fixture(t, { handle(method) { if (method === 'initialize') return { codexHome: '/foreign/real-user-codex' }; } });
  const result = await f.auth.status();
  assert.equal(result.readiness, 'needs_login'); assert.equal(result.diagnostic.code, 'profile_not_isolated');
  assert.deepEqual(f.calls.map(call => call.method), ['initialize']); assert.equal(f.transports[0].closed, true);
});

test('Dots refuses a profile junction or symlink without starting a runtime', async t => {
  const f = fixture(t);
  const foreign = path.join(f.root, 'unrelated-profile'); fs.mkdirSync(foreign); fs.mkdirSync(f.dataDir);
  fs.writeFileSync(path.join(foreign, 'auth.json'), 'unrelated-private-auth');
  try { fs.symlinkSync(foreign, path.join(f.dataDir, 'codex-profile'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (failure) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(failure.code)) { t.skip('This host cannot create test links.'); return; } throw failure; }
  const result = await f.auth.status();
  assert.equal(result.diagnostic.code, 'profile_not_isolated'); assert.equal(f.transports.length, 0);
  assert.equal(fs.readFileSync(path.join(foreign, 'auth.json'), 'utf8'), 'unrelated-private-auth');
});

test('a fresh official login exposes only the authorization URL and reaches ready after its matching receipt', async t => {
  const f = fixture(t);
  const starting = await f.auth.login('start');
  assert.equal(starting.state, 'pending'); assert.equal(starting.browserOpened, false);
  assert.equal(new URL(starting.url).hostname, 'auth.openai.com');
  assert.deepEqual(f.calls.find(call => call.method === 'account/login/start').params, { type: 'chatgpt' });
  await f.auth.login('start'); assert.equal(f.calls.filter(call => call.method === 'account/login/start').length, 1);
  f.signIn(); f.notify('account/login/completed', { loginId: 'foreign-login', success: true });
  assert.equal((await f.auth.login('status')).state, 'pending');
  f.notify('account/login/completed', { loginId: starting.loginId, success: true });
  await until(() => f.calls.some(call => call.method === 'getAuthStatus'));
  await nextTurn();
  const ready = await f.auth.login('status');
  assert.equal(ready.state, 'ready');
  assert.deepEqual(await f.auth.getAuth(), { token, accountId: 'account-owned', userId: 'user-owned' });
  for (const value of [ready, await f.auth.status()]) {
    assert.equal(JSON.stringify(value).includes(token), false);
    assert.equal(JSON.stringify(value).includes('private@example.invalid'), false);
    assert.equal(JSON.stringify(value).includes('account-owned'), false);
  }
});

test('a login completion arriving before the start response is matched by loginId', async t => {
  const f = fixture(t, { handle(method, _params, rpc, state) {
    if (method === 'account/login/start') {
      state.account = { type: 'chatgpt' };
      rpc.emit('notification', 'account/login/completed', { loginId: 'fast-login', success: true });
      return { type: 'chatgpt', loginId: 'fast-login', authUrl: 'https://chatgpt.com/auth/login?state=offline' };
    }
  } });
  assert.equal((await f.auth.login('start')).state, 'ready');
});

test('cancel while initialize is pending prevents a late login request and never reads a foreign session', async t => {
  const gate = deferred();
  const f = fixture(t, { handle(method, _params, rpc) {
    if (method === 'initialize') return gate.promise.then(() => ({ codexHome: rpc.settings.env.CODEX_HOME }));
  } });
  const starting = f.auth.login('start'); await until(() => f.calls.some(call => call.method === 'initialize'));
  assert.equal((await f.auth.login('cancel')).state, 'idle');
  gate.resolve(); assert.equal((await starting).state, 'idle');
  assert.equal(f.calls.some(call => call.method === 'account/login/start'), false);
  assert.equal(f.transports[0].closed, true);
});

test('cancel and later login cannot accept an old completion or close the new flow', async t => {
  const cancelGate = deferred();
  const f = fixture(t, { handle(method) { if (method === 'account/login/cancel') return cancelGate.promise; } });
  const first = await f.auth.login('start');
  const oldRpc = f.transports[0], cancelling = f.auth.login('cancel');
  const secondStart = f.auth.login('start');
  await nextTurn(); assert.equal(f.calls.filter(call => call.method === 'account/login/start').length, 1);
  cancelGate.resolve({ status: 'canceled' }); await cancelling;
  const second = await secondStart;
  assert.notEqual(first.loginId, second.loginId); assert.equal(f.transports.length, 2);
  oldRpc.emit('notification', 'account/login/completed', { loginId: second.loginId, success: true });
  assert.equal((await f.auth.login('status')).state, 'pending');
  assert.equal(f.transports[1].closed, false);
});

test('untrusted login URLs and runtime error text cannot escape through public login results', async t => {
  const f = fixture(t, { handle(method) {
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'bad-login', authUrl: 'https://auth.openai.com.attacker.test/private-token' };
  } });
  const result = await f.auth.login('start');
  assert.equal(result.state, 'failed'); assert.equal(result.url, undefined);
  assert.equal(result.diagnostic.code, 'invalid_authorization_url');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.ok(f.calls.some(call => call.method === 'account/login/cancel'));
});

test('official cancellation and logout use only the owned runtime and never issue model requests', async t => {
  const f = fixture(t, { signedIn: true });
  assert.equal((await f.auth.status()).readiness, 'ready');
  assert.equal((await f.auth.login('logout')).state, 'idle');
  assert.equal(await f.auth.getAuth(), null);
  assert.ok(f.calls.some(call => call.method === 'account/logout'));
  const allowed = new Set(['initialize', 'initialized', 'account/read', 'getAuthStatus', 'account/login/start', 'account/login/cancel', 'account/logout']);
  assert.ok(f.calls.every(call => allowed.has(call.method)));
});

test('optional refresh is serialized and performed once by account/read, never by a second token exporter', async t => {
  let reads = 0, simultaneous = 0, maximum = 0;
  const f = fixture(t, { signedIn: true, async handle(method) {
    if (method === 'account/read') { reads++; simultaneous++; maximum = Math.max(maximum, simultaneous); await nextTurn(); simultaneous--; }
  } });
  await Promise.all([f.auth.getAuth({ refreshToken: true }), f.auth.getAuth({ refreshToken: true })]);
  assert.equal(reads, 2); assert.equal(maximum, 1);
  assert.ok(f.calls.filter(call => call.method === 'account/read').every(call => call.params.refreshToken === true));
  assert.ok(f.calls.filter(call => call.method === 'getAuthStatus').every(call => call.params.includeToken === true && call.params.refreshToken === false));
});

test('only managed ChatGPT tokens with consistent account identity can reach the Dot adapter', async t => {
  const f = fixture(t, { signedIn: true });
  f.state.authMethod = 'personalAccessToken'; assert.equal(await f.auth.getAuth(), null);
  f.state.authMethod = 'chatgpt'; f.state.workspaceRouting = { chatgptAccountId: 'other-account' };
  await assert.rejects(f.auth.getAuth(), { code: 'account_identity_mismatch' });
  f.state.workspaceRouting = null; f.state.token = jwt({ chatgpt_account_id: 'bad\r\nheader' });
  await assert.rejects(f.auth.getAuth(), { code: 'account_identity_missing' });
  f.state.token = 'opaque-token'; f.state.workspaceRouting = { chatgptAccountId: 'account-owned' };
  await assert.rejects(f.auth.getAuth(), { code: 'account_identity_missing' });
});

test('raw JWT sub binds two users in the same workspace separately before any Dot request', async t => {
  const f = fixture(t, { signedIn: true });
  f.state.workspaceRouting = { chatgptAccountId: 'shared-workspace' };
  f.state.token = jwt({ chatgpt_account_id: 'shared-workspace' }, 'auth0|first-person');
  const first = await f.auth.getAuth();
  assert.equal(first.userId, 'auth0|first-person');
  let dispatched = false;
  const client = createDotsClient({ getAuth: f.auth.getAuth, fetchImpl: async () => { dispatched = true; assert.fail('A switched user must be rejected before network dispatch.'); } });
  const boundIdentity = await client.identity();
  f.state.token = jwt({ chatgpt_account_id: 'shared-workspace' }, 'auth0|second-person');
  const second = await f.auth.getAuth();
  assert.equal(second.accountId, first.accountId); assert.notEqual(second.userId, first.userId);
  await assert.rejects(client.request('/tbo', { expectedKey: boundIdentity }), { code: 'account_changed' });
  assert.equal(dispatched, false);
});

test('workspace routing alone and malformed token principals cannot release a token to Dots', async t => {
  const f = fixture(t, { signedIn: true });
  f.state.workspaceRouting = { chatgptAccountId: 'shared-workspace' };
  for (const candidate of [jwt({ chatgpt_account_id: 'shared-workspace' }),
    jwt({ chatgpt_account_id: 'shared-workspace' }, 'unsafe\r\nprincipal'), 'opaque-token']) {
    f.state.token = candidate;
    await assert.rejects(f.auth.getAuth(), failure => failure.code === 'account_identity_missing' && !failure.message.includes(candidate));
  }
});

test('failed official account reads and login notifications are redacted and cannot claim ready', async t => {
  const f = fixture(t, { handle(method) { if (method === 'account/read') throw new Error('private-token private@example.invalid'); } });
  const status = await f.auth.status();
  assert.equal(status.readiness, 'needs_login'); assert.equal(JSON.stringify(status).includes('private'), false);
  const started = await f.auth.login('start');
  f.notify('account/login/completed', { loginId: started.loginId, success: false, error: 'private-token in upstream URL' });
  const failed = await f.auth.login('status');
  assert.equal(failed.state, 'failed'); assert.equal(JSON.stringify(failed).includes('private-token'), false);
});

test('closing the auth client stops only its host and prevents new account reads', async t => {
  const f = fixture(t);
  await f.auth.status(); const count = f.calls.length;
  await f.auth.close();
  await assert.rejects(f.auth.getAuth(), { code: 'runtime_closed' });
  await assert.rejects(f.auth.login('start'), { code: 'runtime_closed' });
  assert.equal(f.calls.length, count); assert.ok(f.transports.every(rpc => rpc.closed));
});

test('auth close waits for the actual child exit before returning its Windows profile', async t => {
  const f = fixture(t); await f.auth.status();
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.kill = () => assert.fail('The child should exit before another signal is needed.');
  f.transports[0].child = child;
  let exited = false;
  const timer = setTimeout(() => { exited = true; child.exitCode = 0; child.emit('exit', 0); }, 20);
  await f.auth.close(); clearTimeout(timer);
  assert.equal(exited, true);
});
