import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createMusePersonalAdapter, inspectMuseHistory } from '../runtime/muse-personal.mjs';
import { createMuseBrowserLogin } from '../runtime/muse-browser-login.mjs';
import { hash } from '../lib/util.mjs';

const run = () => ({ id: 'run-muse-one', taskId: 'task-one', title: '整理资料', instruction: '整理提供的资料',
  agentId: 'vm-original', protocol: 'muse-personal', deliveryStatus: 'pending', runtimeData: {} });
const marker = '[AntDesk 事项 run-muse-one]';
const user = { seq: 11, role: 'user', text: marker + '\n任务内容', messageId: 'user-11', status: '' };
const reply = { seq: 12, role: 'assistant', text: '原 Muse 的真实回复', messageId: 'reply-12', status: 'completed', replyTo: '' };
const savedCookies = 'hatch_sess=dedicated-test-secret';
const verifiedConfig = () => ({ authState: 'ready', account: { id: 'vm-original', name: '原 Muse' }, credentialFingerprint: hash(savedCookies) });

function fixture(behavior = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-muse-test-'));
  let config = { ...behavior.initialConfig }, secret = behavior.noCookies ? '' : 'hatch_sess=dedicated-test-secret';
  const calls = [], events = [], settings = [], workers = [];
  class FakeRpc extends EventEmitter {
    constructor() { super(); this.closed = false; workers.push(this); }
    async open() {}
    async call(method, params) {
      calls.push({ method, params });
      if (behavior.handle) { const handled = await behavior.handle(method, params, { calls, events }); if (handled !== undefined) return handled; }
      if (method === 'initialize') return { initialized: true, sdkVersion: '0.3.10', account: { id: 'vm-original', name: '原 Muse' } };
      if (method === 'account/read') return { account: { id: 'vm-original', name: '原 Muse' } };
      if (method === 'session/create') return { sessionId: 'side-one' };
      if (method === 'session/rename') return { renamed: true };
      if (method === 'history/read') return params.limit === 1 ? { events: [], maxSeq: 10 } : { events: [user, reply], maxSeq: 12 };
      if (method === 'chat/send') {
        assert.ok(events.some(event => event.type === 'checkpoint' && event.data?.sendIntent === true), 'durable send intent must precede transmission');
        return { submitted: true, accepted: false };
      }
      if (method === 'sessions/list') return { sessions: [{ id: 'side-one', sessionId: 'side-one', name: 'AntDesk 事项' }] };
      if (method === 'shutdown') return { closed: true, remoteStopped: false };
      throw new Error('Unexpected method ' + method);
    }
    async close() { this.closed = true; this.emit('disconnect'); }
  }
  const browserCalls = [];
  const adapter = createMusePersonalAdapter({ projectRoot: folder, toolsDir: folder, dataDir: path.join(folder, 'data'),
    getSecret: () => secret, setSecret: (_name, value) => { secret = value; },
    getConfig: () => config, setConfig: patch => { config = { ...config, ...patch }; },
    transportFactory: opts => { settings.push(opts); return new FakeRpc(); },
    browserLoginFactory: params => ({ async login(action) { browserCalls.push(action); if (action === 'logout') params.setSecret('cookies', ''); return { state: action === 'start' ? 'waiting' : 'idle' }; }, async close() {} }),
    pollIntervalMs: 0, maxWaitMs: 100, ...behavior.options });
  return { adapter, calls, events, settings, workers, browserCalls, config: () => config, setCookies: value => { secret = value; },
    emit: event => events.push(structuredClone(event)),
    async cleanup() { await adapter.close(); fs.rmSync(folder, { recursive: true, force: true }); } };
}

test('Muse history needs its own input and an explicitly completed, non-proactive reply', () => {
  const checkpoint = { marker, baseline: 10 };
  assert.equal(inspectMuseHistory([reply], checkpoint).result, '');
  assert.equal(inspectMuseHistory([user, { ...reply, status: 'failed' }], checkpoint).result, '');
  assert.equal(inspectMuseHistory([user, { ...reply, status: 'running' }], checkpoint).result, '');
  assert.equal(inspectMuseHistory([user, { ...reply, replyTo: 'self-ref' }], checkpoint).result, '');
  assert.equal(inspectMuseHistory([user, reply], checkpoint).result, reply.text);
  assert.equal(inspectMuseHistory([user, { ...user, seq: 13 }, reply], checkpoint).ambiguous, true);
  assert.equal(inspectMuseHistory([user, { seq: 13, role: 'user', text: '另一个客户端的输入' }, reply], checkpoint).ambiguous, true);
});

test('Muse sends once into a new side session after persisting its baseline and intent', async () => {
  const f = fixture();
  try {
    await f.adapter.start(run(), f.emit);
    assert.equal(f.calls.filter(call => call.method === 'session/create').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'chat/send').length, 1);
    const sent = f.calls.find(call => call.method === 'chat/send').params;
    assert.equal(sent.sessionId, 'side-one'); assert.ok(sent.text.includes(marker));
    assert.equal(f.events.find(event => event.type === 'started').turnId, 'user-11');
    assert.equal(f.events.find(event => event.type === 'complete').text, reply.text);
    assert.equal(f.config().sessions['side-one'].status, 'review');
    assert.ok(f.settings.every(settings => !JSON.stringify(settings).includes('dedicated-test-secret')));
    assert.ok(!JSON.stringify(f.events).includes('dedicated-test-secret'));
    assert.ok(f.workers.every(worker => worker.closed));
  } finally { await f.cleanup(); }
});

test('Muse uncertain send persists its original side session and recovery never posts another task', async () => {
  let rejectSend = true;
  const f = fixture({ handle(method) { if (method === 'chat/send' && rejectSend) throw new Error('socket closed after write'); } });
  try {
    const original = run(); await f.adapter.start(original, f.emit);
    assert.ok(f.events.some(event => event.type === 'interrupted' && event.deliveryStatus === 'unknown'));
    const data = Object.assign({}, ...f.events.filter(event => event.type === 'checkpoint').map(event => event.data));
    assert.equal(data.sendIntent, true); assert.equal(data.sessionId, 'side-one'); assert.equal(data.baseline, 10);
    rejectSend = false; f.calls.length = 0; f.events.length = 0;
    await f.adapter.recover({ ...original, status: 'interrupted', runtimeData: data }, f.emit);
    assert.equal(f.calls.some(call => ['chat/send', 'session/create', 'session/rename'].includes(call.method)), false);
    assert.equal(f.events.find(event => event.type === 'complete').text, reply.text);
  } finally { await f.cleanup(); }
});

test('Muse does not send into a selected old conversation or resume without an attributable checkpoint', async () => {
  const f = fixture();
  try {
    await f.adapter.start({ ...run(), sessionId: 'personal-main' }, f.emit);
    assert.equal(f.events[0].type, 'failed'); assert.equal(f.calls.length, 0);
    f.events.length = 0;
    await f.adapter.recover({ ...run(), runtimeData: { sessionId: 'side-one' } }, f.emit);
    assert.equal(f.events[0].type, 'interrupted'); assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('Muse refuses readback under a different logged-in account and never fabricates remote cancellation', async () => {
  const f = fixture();
  try {
    await f.adapter.recover({ ...run(), runtimeData: { accountId: 'other-vm', sessionId: 'side-one', marker, baseline: 10, sendIntent: true } }, f.emit);
    assert.equal(f.calls.some(call => call.method === 'history/read'), false);
    assert.ok(f.events.some(event => event.type === 'interrupted' && /账号/.test(event.message)));
    assert.equal((await f.adapter.cancel(run())).remoteStopped, false);
    assert.equal(f.calls.some(call => call.method === 'chat/cancel'), false);
  } finally { await f.cleanup(); }
});

test('Muse login uses the dedicated browser helper and reports the community provenance', async () => {
  const f = fixture({ noCookies: true });
  try {
    const status = await f.adapter.status();
    assert.equal(status.official, false); assert.equal(status.protocol, 'muse-personal'); assert.equal(status.readiness, 'needs_login');
    assert.equal(f.calls.length, 0, 'Checking a logged-out provider must not contact an account');
    const login = await f.adapter.login('start'); assert.equal(login.state, 'waiting');
    await f.adapter.login('cancel'); await f.adapter.login('logout');
    assert.deepEqual(f.browserCalls, ['start', 'cancel', 'logout']);
  } finally { await f.cleanup(); }
});

test('Muse cancellation while side-session creation is pending cannot send a task afterwards', async () => {
  let release, creating;
  const began = new Promise(resolve => { creating = resolve; });
  const f = fixture({ handle(method) {
    if (method === 'session/create') { creating(); return new Promise(resolve => { release = resolve; }); }
  } });
  try {
    const starting = f.adapter.start(run(), f.emit);
    await began;
    const stopped = await f.adapter.cancel(run()); assert.equal(stopped.remoteStopped, false);
    release({ sessionId: 'side-one' }); await starting;
    assert.equal(f.calls.some(call => call.method === 'chat/send'), false);
    assert.equal(f.events.some(event => event.type === 'complete'), false);
  } finally { await f.cleanup(); }
});

test('Muse passive saved-cookie AuthError clears readiness even when the browser helper absorbs the exception', async () => {
  const f = fixture({ initialConfig: verifiedConfig(),
    handle(method) { if (method === 'initialize') throw Object.assign(new Error('Authentication failed'), { data: { kind: 'AuthError' } }); },
    options: { browserLoginFactory: options => createMuseBrowserLogin({ ...options,
      launch: async () => { throw new Error('Passive validation must never open a browser'); } }) } });
  try {
    assert.equal((await f.adapter.status()).readiness, 'ready');
    let state = await f.adapter.login('status');
    for (let tries = 0; tries < 30 && state.state === 'pending'; tries++) {
      await new Promise(resolve => setImmediate(resolve));
      state = await f.adapter.login('status');
    }
    assert.equal(state.state, 'failed');
    assert.equal(f.config().authState, 'expired');
    assert.equal((await f.adapter.status()).readiness, 'needs_login');
    assert.ok(!JSON.stringify(state).includes('dedicated-test-secret'));
  } finally { await f.cleanup(); }
});

test('Muse preserves saved readiness when the SDK labels an HTTP 503 as AuthError', async () => {
  const f = fixture({ initialConfig: verifiedConfig(), handle(method) {
    if (method === 'initialize') throw Object.assign(new Error('private response body'), {
      data: { kind: 'AuthError', stage: 'authorization', code: 'service_unavailable', httpStatus: 503, retryable: true } });
  } });
  try {
    await assert.rejects(f.adapter.agents());
    assert.equal(f.config().authState, 'ready');
    assert.equal((await f.adapter.status()).readiness, 'ready');
  } finally { await f.cleanup(); }
});

test('Muse login verification uses the longer initialization deadline and forwards cancellation', async () => {
  let verifyCandidate, signalSeen, initializeTimeout;
  const f = fixture({ options: { browserLoginFactory: options => {
    verifyCandidate = options.verifyCookies;
    return { async login() { return { state: 'idle' }; }, async close() {} };
  }, transportFactory: () => {
    const rpc = new EventEmitter(); rpc.closed = false;
    rpc.open = async () => {};
    rpc.call = async (method, _params, settings) => {
      if (method === 'initialize') {
        signalSeen = settings.signal; initializeTimeout = settings.timeoutMs;
        return { initialized: true, sdkVersion: '0.3.10', account: { id: 'vm-original', name: 'Muse' } };
      }
      if (method === 'account/read') return { account: { id: 'vm-original' } };
      return {};
    };
    rpc.close = async () => { rpc.closed = true; };
    return rpc;
  } } });
  try {
    await f.adapter.login('status');
    const controller = new AbortController();
    assert.equal((await verifyCandidate('hatch_sess=new-candidate', { signal: controller.signal })).ok, true);
    assert.equal(signalSeen, controller.signal); assert.equal(initializeTimeout, 150000);
    controller.abort();
    await assert.rejects(verifyCandidate('hatch_sess=cancelled', { signal: controller.signal }), { code: 'ABORT_ERR' });
  } finally { await f.cleanup(); }
});

test('Muse failed candidate login leaves the verified saved account ready', async () => {
  let verifyCandidate;
  const f = fixture({ initialConfig: verifiedConfig(),
    handle(method, params) {
      if (method === 'initialize' && params.cookies === 'hatch_sess=new-invalid-candidate') {
        throw Object.assign(new Error('Candidate expired'), { data: { kind: 'AuthError' } });
      }
    },
    options: { browserLoginFactory: options => {
      verifyCandidate = options.verifyCookies;
      return { async login() { return { state: 'idle' }; }, async close() {} };
    } } });
  try {
    await f.adapter.login('cancel');
    await assert.rejects(verifyCandidate('hatch_sess=new-invalid-candidate'));
    assert.equal(f.config().authState, 'ready');
    assert.equal(f.config().account.id, 'vm-original');
    const status = await f.adapter.status();
    assert.equal(status.readiness, 'ready');
    assert.match(status.message, /已保存/);
    assert.match(status.message, /重新验证/);
  } finally { await f.cleanup(); }
});

test('Muse cached browser ready cannot undo a later confirmed saved-login expiration', async () => {
  let verifySaved, failAuth = false;
  const f = fixture({
    handle(method) { if (method === 'initialize' && failAuth) throw Object.assign(new Error('Expired'), { data: { kind: 'AuthError' } }); },
    options: { browserLoginFactory: options => {
      verifySaved = () => options.verifyCookies(options.getSecret('cookies'));
      return { async login() { return { state: 'ready' }; }, async close() {} };
    } } });
  try {
    await f.adapter.login('status');
    await verifySaved();
    assert.equal((await f.adapter.login('status')).state, 'ready');
    failAuth = true;
    await assert.rejects(f.adapter.agents());
    assert.equal(f.config().authState, 'expired');
    assert.equal((await f.adapter.login('status')).state, 'failed');
    assert.equal((await f.adapter.status()).readiness, 'needs_login');
  } finally { await f.cleanup(); }
});

test('Muse legacy saved login acquires account identity in the background without exposing a cookie fingerprint', async () => {
  const f = fixture({ initialConfig: { authState: 'ready' } });
  try {
    const first = await f.adapter.status();
    assert.equal(first.readiness, 'connecting'); assert.equal(first.connectionIdentity, undefined);
    for (let i = 0; i < 30 && !f.config().account; i++) await new Promise(resolve => setImmediate(resolve));
    const ready = await f.adapter.status();
    assert.equal(ready.readiness, 'ready'); assert.equal(ready.agentId, 'vm-original');
    assert.equal(ready.connectionIdentity, hash(JSON.stringify(['muse', 'vm-original'])));
    assert.ok(!JSON.stringify(ready).includes(savedCookies));
    assert.ok(!JSON.stringify(ready).includes(hash(savedCookies)));
    assert.equal(f.browserCalls.length, 0);
    assert.equal(f.calls.filter(call => call.method === 'initialize').length, 1);
  } finally { await f.cleanup(); }
});

test('Muse identity is stable across cookie renewal and changes only with the verified account', async () => {
  const f = fixture({ initialConfig: verifiedConfig(), handle(method, params) {
    if (method === 'initialize' && params.cookies === 'hatch_sess=another-account')
      return { initialized: true, sdkVersion: '0.3.10', account: { id: 'other-original', name: '另一位 Muse' } };
  } });
  try {
    const original = await f.adapter.status();
    f.setCookies('hatch_sess=renewed-cookie'); await f.adapter.agents();
    assert.equal((await f.adapter.status()).connectionIdentity, original.connectionIdentity);
    f.setCookies('hatch_sess=another-account'); await f.adapter.agents();
    const other = await f.adapter.status(); assert.equal(other.agentId, 'other-original');
    assert.notEqual(other.connectionIdentity, original.connectionIdentity);
  } finally { await f.cleanup(); }
});

test('Muse stale account verification cannot expire a newly verified login', async () => {
  let rejectOld, began;
  const entered = new Promise(resolve => { began = resolve; });
  const f = fixture({ initialConfig: verifiedConfig(), handle(method, params) {
    if (method !== 'initialize') return;
    if (params.cookies === savedCookies) { began(); return new Promise((_resolve, reject) => { rejectOld = reject; }); }
    return { initialized: true, sdkVersion: '0.3.10', account: { id: 'fresh-account', name: 'Fresh' } };
  } });
  try {
    const old = f.adapter.agents().catch(failure => failure); await entered;
    f.setCookies('hatch_sess=fresh-account'); await f.adapter.agents();
    rejectOld(Object.assign(new Error('Old account expired'), { data: { kind: 'AuthError', code: 'auth_required' } }));
    await old;
    assert.equal(f.config().authState, 'ready'); assert.equal(f.config().account.id, 'fresh-account');
    assert.equal((await f.adapter.status()).agentId, 'fresh-account');
  } finally { await f.cleanup(); }
});

test('Muse logout invalidates late background identity verification', async () => {
  let release, began;
  const entered = new Promise(resolve => { began = resolve; });
  const f = fixture({ handle(method) {
    if (method === 'initialize') { began(); return new Promise(resolve => { release = resolve; }); }
  } });
  try {
    assert.equal((await f.adapter.status()).readiness, 'connecting'); await entered;
    await f.adapter.login('logout');
    release({ initialized: true, sdkVersion: '0.3.10', account: { id: 'vm-original', name: 'Old' } });
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.config().authState, 'idle'); assert.equal(f.config().account, null);
    const status = await f.adapter.status(); assert.equal(status.readiness, 'needs_login'); assert.equal(status.connectionIdentity, undefined);
  } finally { await f.cleanup(); }
});

test('Muse late candidate account read cannot resurrect metadata after logout', async () => {
  let verify, release, began;
  const entered = new Promise(resolve => { began = resolve; });
  const f = fixture({ handle(method) {
    if (method === 'account/read') { began(); return new Promise(resolve => { release = resolve; }); }
  }, options: { browserLoginFactory: opts => {
    verify = opts.verifyCookies;
    return { async login(action) { if (action === 'logout') opts.setSecret('cookies', ''); return { state: 'idle' }; }, async close() {} };
  } } });
  try {
    await f.adapter.login('cancel'); const pending = verify(savedCookies); await entered;
    await f.adapter.login('logout'); release({ account: { id: 'vm-original' } });
    assert.equal((await pending).ok, false);
    assert.equal(f.config().authState, 'idle'); assert.equal(f.config().account, null);
    assert.equal((await f.adapter.status()).connectionIdentity, undefined);
  } finally { await f.cleanup(); }
});

test('Muse legacy identity timeout is visible, retains login, and does not restart on every provider poll', async () => {
  const f = fixture({ initialConfig: { authState: 'ready' }, handle(method) {
    if (method === 'initialize') throw Object.assign(new Error('private upstream body ' + savedCookies), { code: 'RPC_TIMEOUT' });
  } });
  try {
    assert.equal((await f.adapter.status()).readiness, 'connecting');
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 4; i++) {
      const status = await f.adapter.status();
      assert.equal(status.readiness, 'unavailable'); assert.match(status.message, /核验超时/);
      assert.equal(status.connectionIdentity, undefined); assert.equal(status.agentId, undefined);
      assert.ok(!JSON.stringify(status).includes(savedCookies)); assert.ok(!JSON.stringify(status).includes('private upstream body'));
    }
    assert.equal(f.calls.filter(call => call.method === 'initialize').length, 1);
    assert.equal(f.config().authState, 'ready'); assert.equal(f.config().account, undefined);
    assert.equal(f.browserCalls.length, 0); assert.equal(f.calls.some(call => ['chat/send', 'session/create'].includes(call.method)), false);
  } finally { await f.cleanup(); }
});

test('Muse keeps the last identity error visible during a retry and becomes ready only after verified success', async () => {
  let attempts = 0, release;
  const f = fixture({ initialConfig: { authState: 'ready' }, options: { identityRetryDelayMs: 0 }, handle(method) {
    if (method !== 'initialize') return;
    if (++attempts === 1) throw Object.assign(new Error('private 503 response'), { data: { kind: 'AuthError', code: 'service_unavailable' } });
    return new Promise(resolve => { release = resolve; });
  } });
  try {
    await f.adapter.status(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    const retrying = await f.adapter.status();
    assert.equal(retrying.readiness, 'unavailable'); assert.match(retrying.message, /服务暂时不可用.*后台重新核验/);
    assert.equal(retrying.connectionIdentity, undefined); assert.equal(f.config().authState, 'ready');
    for (let i = 0; i < 4 && !release; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2); assert.equal((await f.adapter.status()).readiness, 'unavailable');
    release({ initialized: true, sdkVersion: '0.3.10', account: { id: 'vm-original', name: 'Muse' } });
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    const ready = await f.adapter.status(); assert.equal(ready.readiness, 'ready'); assert.equal(ready.agentId, 'vm-original');
    assert.equal(ready.connectionIdentity, hash(JSON.stringify(['muse', 'vm-original']))); assert.ok(!/不可用|重试|private/.test(ready.message));
  } finally { await f.cleanup(); }
});

test('Muse identity failure and cooldown do not carry over to a different saved cookie', async () => {
  const f = fixture({ initialConfig: { authState: 'ready' }, handle(method, params) {
    if (method !== 'initialize') return;
    if (params.cookies === savedCookies) throw Object.assign(new Error('sensitive network failure'), { data: { code: 'network_error' } });
    return { initialized: true, sdkVersion: '0.3.10', account: { id: 'new-account', name: 'New Muse' } };
  } });
  try {
    await f.adapter.status(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.adapter.status()).readiness, 'unavailable');
    f.setCookies('hatch_sess=new-login'); const changed = await f.adapter.status();
    assert.equal(changed.readiness, 'connecting'); assert.ok(!/无法连接|sensitive/.test(changed.message));
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    const ready = await f.adapter.status(); assert.equal(ready.readiness, 'ready'); assert.equal(ready.agentId, 'new-account');
    assert.equal(f.calls.filter(call => call.method === 'initialize').length, 2);
  } finally { await f.cleanup(); }
});

test('Muse legacy identity check distinguishes confirmed expired authorization from transient failure', async () => {
  const f = fixture({ initialConfig: { authState: 'ready' }, handle(method) {
    if (method === 'initialize') throw Object.assign(new Error('private rejected cookie'), { data: { kind: 'AuthError', code: 'auth_required' } });
  } });
  try {
    await f.adapter.status(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    const status = await f.adapter.status(); assert.equal(status.readiness, 'needs_login'); assert.equal(f.config().authState, 'expired');
    assert.equal(status.connectionIdentity, undefined); assert.ok(!status.message.includes('private')); assert.equal(f.browserCalls.length, 0);
  } finally { await f.cleanup(); }
});
