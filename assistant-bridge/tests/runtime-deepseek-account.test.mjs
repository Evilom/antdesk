import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDeepSeekAccount } from '../runtime/deepseek-account.mjs';
import { createDeepSeekWebHost } from '../runtime/deepseek-host.mjs';
import { createDeepSeekAdapter } from '../runtime/deepseek.mjs';

async function until(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Expected local account state did not arrive.');
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-deepseek-account-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
class AccountHost {
  origin = 'http://127.0.0.1:32123';
  view = { status: 'signed-out', attempt: null };
  calls = [];
  closed = false;
  profile = { status: 'ready', value: { name: 'Test Account', contact: 'a***@example.test', token: 'never-return-this-field' } };
  handlers = {};
  async open() { return { origin: this.origin }; }
  async call(method, args = {}) {
    this.calls.push({ method, args });
    if (this.handlers[method]) return this.handlers[method](args);
    if (method === 'account/getState') return structuredClone(this.view);
    if (method === 'account/startSignIn') return this.view = { status: 'signed-out', attempt: { id: 'attempt1', phase: 'initializing' } };
    if (method === 'account/cancelSignIn') {
      if (this.view.status !== 'credential-stored') this.view = { status: 'signed-out', attempt: { id: args.attemptId, phase: 'cancelled' } };
      return structuredClone(this.view);
    }
    if (method === 'account/signOut') return this.view = { status: 'signed-out', attempt: null };
    if (method === 'account/getProfile') return this.profile;
    if (method === 'session/modelCatalog') return { groups: [
      { id: 'deepseek-official', models: [{ id: 'wrong-api-model', name: 'Must not be used' }] },
      { id: 'deepseek-account', models: [{ id: 'account-model', name: 'Official Account Model', token: 'never-return-this-field' }] },
    ], failures: [] };
    throw new Error('Unexpected Host request.');
  }
  async close() { this.closed = true; }
}

function accountFixture(t, extra = {}) {
  const root = temporary(t), host = new AccountHost(), opened = [];
  const account = createDeepSeekAccount({ dataDir: root, python: 'unused', hostFactory: () => host,
    openBrowser: async url => { opened.push(url); }, ...extra });
  t.after(() => account.close());
  return { account, host, opened, root };
}

test('DeepSeek account status only queries the owned Host and never starts login', async t => {
  const { account, host, opened } = accountFixture(t);
  const result = await account.refresh();
  assert.equal(result.state, 'idle');
  assert.equal(result.accountStored, false);
  assert.deepEqual(host.calls.map(row => row.method), ['account/getState']);
  assert.deepEqual(opened, []);
});

test('DeepSeek official login hands off once, validates the stored grant, and uses only the account catalog', async t => {
  const { account, host, opened } = accountFixture(t);
  assert.equal((await account.login('start')).state, 'pending');
  await until(() => host.calls.some(row => row.method === 'account/startSignIn'));
  host.view = { status: 'signed-out', attempt: { id: 'attempt1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?authorize_id=fixture' } };
  await account.refresh();
  await account.refresh();
  assert.equal(opened.length, 1);
  const request = host.calls.find(row => row.method === 'account/startSignIn');
  assert.deepEqual(Object.keys(request.args).sort(), ['callbackOrigin', 'client', 'loginSource']);
  assert.equal(request.args.callbackOrigin, host.origin);
  assert.equal(request.args.client.version, '0.2.1-rc.2');
  host.view = { status: 'credential-stored', attempt: { id: 'attempt1', phase: 'succeeded' } };
  const ready = await account.refresh();
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.models, [{ id: 'account-model', name: 'Official Account Model' }]);
  assert.equal(JSON.stringify(ready).includes('never-return-this-field'), false);
  assert.equal(host.calls.some(row => row.method.includes('resolveToken') || row.method.includes('getPlatformSession')), false);
});

test('DeepSeek stored credentials are not declared verified when official profile lookup fails', async t => {
  const { account, host } = accountFixture(t);
  host.view = { status: 'credential-stored', attempt: null };
  host.profile = { status: 'failed' };
  const result = await account.refresh();
  assert.equal(result.state, 'failed');
  assert.equal(result.accountStored, true);
  assert.equal(result.code, 'account_unverified');
  assert.equal(host.calls.some(row => row.method === 'session/modelCatalog'), false);
});

test('DeepSeek rejects an unexpected browser destination and cancels its official attempt', async t => {
  const { account, host, opened } = accountFixture(t);
  await account.login('start');
  await until(() => host.calls.some(row => row.method === 'account/startSignIn'));
  host.view = { status: 'signed-out', attempt: { id: 'attempt1', phase: 'waiting-browser', authorizeUrl: 'https://unexpected.example/dsh/authorize?secret=never-open' } };
  const result = await account.refresh();
  assert.equal(result.state, 'failed');
  assert.equal(opened.length, 0);
  assert.ok(host.calls.some(row => row.method === 'account/cancelSignIn'));
});

test('DeepSeek cancelling before the login receipt prevents a delayed browser handoff', async t => {
  const { account, host, opened } = accountFixture(t);
  let acknowledge;
  host.handlers['account/startSignIn'] = () => new Promise(resolve => { acknowledge = () => {
    host.view = { status: 'signed-out', attempt: { id: 'late-attempt', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?authorize_id=late' } };
    resolve(host.view);
  }; });
  await account.login('start');
  await until(() => !!acknowledge);
  const cancel = account.login('cancel');
  acknowledge();
  const result = await cancel;
  assert.equal(result.state, 'idle');
  assert.equal(opened.length, 0);
  assert.equal(host.view.attempt.phase, 'cancelled');
});

test('DeepSeek cancellation after the official commit preserves the logged-in outcome', async t => {
  const { account, host } = accountFixture(t);
  await account.login('start');
  await until(() => host.calls.some(row => row.method === 'account/startSignIn'));
  await new Promise(resolve => setImmediate(resolve));
  host.view = { status: 'credential-stored', attempt: { id: 'attempt1', phase: 'succeeded' } };
  const result = await account.login('cancel');
  assert.equal(result.state, 'ready');
  assert.equal(result.accountStored, true);
});

function hostFixture(t, extra = {}) {
  const root = temporary(t), calls = [], processes = [];
  let settings;
  const host = createDeepSeekWebHost({ python: 'unused', home: root, patchPath: path.join(root, 'safe.json'),
    resolveCommand: async () => ['/official/runtime'],
    spawnProcess: (_command, _args, options) => {
      settings = { command: _command, args: _args, ...options };
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true; };
      processes.push(child);
      queueMicrotask(() => child.stdout.write('dsh web: http://127.0.0.1:32000/?token=offline-owned-launch-token-only\n'));
      return child;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') return new Response(null, { status: 303, headers: { location: './', 'set-cookie': 'dsh-auth-fixture=v1.owned.local; Path=/; HttpOnly; SameSite=Strict' } });
      const input = JSON.parse(options.body);
      return new Response(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: { status: 'signed-out', attempt: null } } }));
    }, ...extra });
  t.after(() => host.close());
  return { host, calls, processes, settings: () => settings };
}

test('DeepSeek local Host uses the official cookie exchange and correlated RPC envelope', async t => {
  const { host, calls, settings, processes } = hostFixture(t);
  const result = await host.call('account/getState');
  assert.equal(result.status, 'signed-out');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[1].url, 'http://127.0.0.1:32000/api/account/getState');
  const input = JSON.parse(calls[1].options.body);
  assert.equal(input.type, 'client-request');
  assert.deepEqual(input.payload, { args: {} });
  assert.equal(calls[1].options.headers.Cookie, 'dsh-auth-fixture=v1.owned.local');
  assert.equal(calls[1].options.headers.Origin, 'http://127.0.0.1:32000');
  assert.ok(settings().args.includes('--no-open'));
  assert.deepEqual(settings().args.slice(-5), ['--host', '127.0.0.1', '--port', '0', '--no-open']);
  assert.equal(settings().shell, false);
  assert.equal(settings().env.DEEPSEEK_API_KEY, undefined);
  await assert.rejects(host.call('account/getPlatformSession'), { code: 'host_method_not_allowed' });
  await host.close();
  assert.equal(processes[0].exitCode, 0);
});

test('DeepSeek local Host rejects mismatched responses and closes after a failed startup exchange', async t => {
  const badRpc = hostFixture(t, { fetchImpl: async (_url, options) => options.method === 'GET'
    ? new Response(null, { status: 303, headers: { location: './', 'set-cookie': 'dsh-auth-fixture=v1.owned.local' } })
    : new Response(JSON.stringify({ type: 'server-response', rpcId: 'different-call', result: { ok: true, value: {} } })) });
  await assert.rejects(badRpc.host.call('account/getState'), { code: 'host_protocol_mismatch' });
  const badLogin = hostFixture(t, { fetchImpl: async () => new Response(null, { status: 303, headers: { location: 'https://outside.example/' } }) });
  await assert.rejects(badLogin.host.open(), { code: 'host_authentication_failed' });
  await badLogin.host.close();
  assert.equal(badLogin.processes[0].exitCode, 0);
});

class WorkerRpc extends EventEmitter {
  calls = []; closed = false;
  async open() { return this; }
  async call(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'initialize') return { initialized: true, sdkVersion: '0.2.1rc2', runtimeVersion: '0.2.1rc2' };
    if (method === 'session/run') return { accepted: true, sessionId: params.sessionId, finalResponse: 'Planned', finishReason: 'stop' };
    return { stopped: true };
  }
  async close() { this.closed = true; }
}

test('DeepSeek account tasks share the official provider home and never receive a saved API key', async t => {
  const root = temporary(t), host = new AccountHost(), transports = [];
  host.view = { status: 'credential-stored', attempt: null };
  let config = { authMode: 'account' }, key = 'saved-api-key-never-copy-to-account';
  const dataDir = path.join(root, 'state');
  const adapter = createDeepSeekAdapter({ projectRoot: root, toolsDir: path.join(root, 'tools'), dataDir,
    getConfig: () => structuredClone(config), setConfig: patch => { config = { ...config, ...patch }; },
    getSecret: () => key, setSecret: (_name, value) => { key = value; },
    accountOptions: { hostFactory: () => host },
    transportFactory: () => { const rpc = new WorkerRpc(); transports.push(rpc); return rpc; },
    apiKeyValidator: async () => ({ state: 'verified', models: [{ id: 'api-model', name: 'API Model' }], message: 'Validated' }),
  });
  t.after(() => adapter.close());
  for (const id of ['first', 'second']) await adapter.start({ id, title: 'Arrange', instruction: 'Plan only' }, () => {});
  const initializations = transports.map(rpc => rpc.calls.find(row => row.method === 'initialize').params);
  assert.equal(initializations[0].home, path.join(dataDir, 'account-home'));
  assert.equal(initializations[0].home, initializations[1].home);
  for (const init of initializations) {
    assert.equal(init.authMode, 'account');
    assert.equal(init.model, 'account-model');
    assert.equal(Object.hasOwn(init, 'apiKey'), false);
    const patch = JSON.parse(fs.readFileSync(init.patchPath, 'utf8'));
    assert.ok(patch.find(row => row.insert)?.insert.some(row => row.name === '@deepseek-ai/dsh-llm-deepseek-account'));
    assert.equal(patch.find(row => row.id === 'tool-fs').disabled, true);
    assert.equal(patch.find(row => row.id === 'session-log-deepseek').config.enabled, false);
  }
  await adapter.login('logout');
  assert.equal(key, 'saved-api-key-never-copy-to-account');
  await adapter.configure({ authMode: 'api_key' });
  assert.equal((await adapter.status()).authentication.mode, 'api_key');
  await adapter.login('logout');
  assert.equal(key, '');
  assert.equal(host.calls.filter(row => row.method === 'account/signOut').length, 1);
});
