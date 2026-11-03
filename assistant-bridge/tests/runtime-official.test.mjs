import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioRpc, isolatedRuntimeEnv } from '../runtime/stdio-rpc.mjs';
import { createMuseAdapter, MUSE_SCHEMA_FINGERPRINT } from '../runtime/muse-code.mjs';
import { createDeepSeekAdapter, DEEPSEEK_DISABLED_PLUGINS } from '../runtime/deepseek.mjs';

function fakeProcess() {
  const child = new EventEmitter();
  child.pid = 7;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.requests = [];
  child.stdin = new Writable({ write(bytes, _encoding, done) { child.requests.push(JSON.parse(bytes)); done(); } });
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.stdin.on('finish', () => child.kill());
  return child;
}

test('official stdio transport matches split JSON-RPC frames and server requests', async () => {
  const child = fakeProcess();
  const rpc = await new StdioRpc({ command: 'official', spawnProcess: () => child }).open();
  const pending = rpc.call('initialize', { clientInfo: { name: 'AntDesk' } });
  const request = child.requests[0];
  // MSP distinguishes the numeric id 1 from the string id "1".
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: String(request.id), result: { version: 'wrong-id-type' } }) + '\n');
  const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { version: '1' } });
  child.stdout.write(response.slice(0, 8));
  child.stdout.write(response.slice(8) + '\r\n');
  assert.deepEqual(await pending, { version: '1' });
  let notification;
  rpc.on('notification', (method, params) => { notification = { method, params }; });
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: 's' } }) + '\n');
  assert.equal(notification.method, 'turn/completed');
  rpc.requestHandler = async (method, params) => ({ method, accepted: params.allowed === true });
  child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'permission/request', params: { allowed: false } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.requests.at(-1), { jsonrpc: '2.0', id: 'server-1', result: { method: 'permission/request', accepted: false } });
  await rpc.close();
});

test('official stdio transport fails pending operations on lost host, without leaking stderr', async () => {
  const child = fakeProcess();
  const rpc = await new StdioRpc({ command: 'official', spawnProcess: () => child }).open();
  const pending = rpc.call('turn/start');
  child.stderr.write('SECRET-NEVER-RETURN');
  child.exitCode = 9;
  child.emit('exit', 9);
  await assert.rejects(pending, error => /exited \(9\)/.test(error.message) && !error.message.includes('SECRET'));
});

test('official stdio transport bounds malformed frames and removes cancelled pending calls', async () => {
  const child = fakeProcess();
  const rpc = await new StdioRpc({ command: 'official', spawnProcess: () => child }).open();
  const controller = new AbortController();
  const pending = rpc.call('session/read', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(rpc.pending.size, 0);
  const malformed = rpc.call('session/read');
  child.stdout.write('not-json\n');
  await assert.rejects(malformed, /invalid JSON-RPC/);
  assert.equal(rpc.pending.size, 0);
});

test('official runtime profiles do not inherit model credentials', () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'secret-test';
  try {
    const env = isolatedRuntimeEnv('/isolated/profile');
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.HOME, '/isolated/profile');
    assert.equal(env.USERPROFILE, '/isolated/profile');
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

class MockRpc extends EventEmitter {
  constructor(settings, handler) { super(); this.settings = settings; this.handler = handler; this.calls = []; this.closed = false; }
  async open() { return this; }
  async call(method, params = {}) { this.calls.push({ method, params }); return this.handler(method, params, this); }
  async notify(method, params = {}) { this.calls.push({ method, params }); }
  async close() { this.closed = true; this.emit('disconnect', new Error('Closed')); }
  send(method, params) { this.emit('notification', method, params); }
}
async function until(check) {
  for (let count = 0; count < 200; count++) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Expected mock runtime event did not arrive.');
}
function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-official-'));
  let config = {};
  const secrets = { apiKey: 'offline-test-key-never-real' };
  const options = { projectRoot: root, toolsDir: path.join(root, 'tools'), dataDir: path.join(root, 'state'),
    getConfig: () => structuredClone(config), setConfig: patch => { config = { ...config, ...patch }; },
    getSecret: key => secrets[key], setSecret: (key, value) => { secrets[key] = value; } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, options, secrets };
}
function museFixture(t, handlers = {}, extra = {}) {
  const env = environment(t), transports = [];
  const adapter = createMuseAdapter({ ...env.options, offlineEcho: true, ...extra,
    transportFactory: settings => {
      const rpc = new MockRpc(settings, async (method, params, transport) => {
        if (handlers[method]) return handlers[method](params, transport);
        if (method === 'initialize') return { schema: { fingerprint: MUSE_SCHEMA_FINGERPRINT }, serverInfo: { version: '1.4.14' }, museHome: path.join(settings.env.XDG_CONFIG_HOME, 'muse') };
        if (method === 'session/start') return { session: { sessionId: params.sessionId }, viewCursor: 'v0' };
        if (method === 'session/resume') return { session: { sessionId: params.sessionId }, history: { mode: 'none' }, pendingRequests: [] };
        if (method === 'session/list') return { sessions: [], nextCursor: null };
        return {};
      });
      transports.push(rpc); return rpc;
    } });
  t.after(() => adapter.close());
  return { ...env, adapter, transports };
}
function finishMuse(rpc, params, answer = '官方回复', terminal = 'completed') {
  rpc.send('item/started', { sessionId: params.sessionId, viewCursor: 'v1', item: { itemId: 'reply', turnId: params.commandId, kind: 'agentMessage', revision: 1, text: '', status: 'inProgress' } });
  rpc.send('item/delta', { sessionId: params.sessionId, itemId: 'reply', viewCursor: 'v2', delta: answer.slice(0, 2) });
  rpc.send('item/completed', { sessionId: params.sessionId, viewCursor: 'v3', item: { itemId: 'reply', turnId: params.commandId, kind: 'agentMessage', revision: 2, text: answer, status: 'completed' } });
  rpc.send('turn/completed', { sessionId: params.sessionId, turnId: params.commandId, viewCursor: 'v4', terminal });
}
const runInput = (id = 'run1') => ({ id, taskId: 'task1', agentId: 'muse-code', title: 'Plan task', instruction: 'Arrange the plan', context: 'Private task context' });

test('Muse official MSP handles response-before-ACK, full item revisions, and UUIDv7 commands', async t => {
  const fixture = museFixture(t, { 'turn/start': (params, rpc) => {
    finishMuse(rpc, params, 'Hello official Muse');
    return { commandId: params.commandId, turnId: params.commandId, status: 'accepted', disposition: 'started' };
  } });
  const events = [];
  await fixture.adapter.start(runInput(), event => events.push(event));
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).text, 'Hello official Muse');
  assert.equal(events.filter(event => event.type === 'started').length, 1);
  const firstMessage = events.findIndex(event => event.type === 'message');
  assert.ok(events.findIndex(event => event.type === 'started') < firstMessage);
  assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.text), ['', 'He', 'Hello official Muse']);
  const rpc = fixture.transports[0];
  for (const call of rpc.calls.filter(call => call.params.commandId)) assert.match(call.params.commandId, /^[a-f\d]{8}-[a-f\d]{4}-7[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  assert.equal(rpc.calls.find(call => call.method === 'session/start').params.approvalMode, 'promptUnmatched');
  assert.ok(rpc.settings.args.includes('--disable-shell'));
  assert.ok(rpc.settings.args.includes('--disable-write'));
  assert.equal(rpc.settings.env.XDG_CONFIG_HOME, path.join(fixture.options.dataDir, 'profile'));
  assert.equal(rpc.settings.env.MUSE_AUTH_PATH, undefined);
});

test('Muse recovery reads the identified original turn and never replays a prompt', async t => {
  const turnId = 'turn-from-server', commandId = 'original-command';
  const fixture = museFixture(t, { 'session/read': params => ({ session: { sessionId: params.sessionId, activeTurnId: null }, viewCursor: 'resume-head',
    history: { items: [
      { itemId: 'older', kind: 'agentMessage', turnId: 'previous-turn', revision: 2, text: 'Do not use previous answer', status: 'completed' },
      { itemId: 'original-user', kind: 'userMessage', commandId, turnId, revision: 1, text: 'Original task', status: 'completed' },
      { itemId: 'original-answer', kind: 'agentMessage', turnId, revision: 2, text: 'Restored official answer', status: 'completed' },
    ] }, lastTurn: { turnId, terminal: 'completed' } }) });
  const events = [];
  await fixture.adapter.recover({ ...runInput(), runtimeData: { sessionId: 'saved-session', turnCommandId: commandId } }, event => events.push(event));
  assert.equal(events.at(-1).text, 'Restored official answer');
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(fixture.transports[0].calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(events.some(event => event.text === 'Do not use previous answer'), false);
});

test('Muse approvals preserve the current requirement guard and user input uses official answer commands', async t => {
  let currentTurn, stage = 1;
  const requirement = n => ({ approvalId: 'approval1', sourceIndex: n });
  const choices = [{ choiceId: 'allow-once-from-host', label: 'Allow once', decision: 'approved', scope: 'once' }, { choiceId: 'deny-from-host', label: 'Deny', decision: 'denied', scope: 'once' }];
  const fixture = museFixture(t, {
    'turn/start': (params, rpc) => {
      currentTurn = params;
      rpc.send('approval/requested', { sessionId: params.sessionId, turnId: params.commandId, approvalId: 'approval1', currentRequirementId: requirement(1), availableChoices: choices, toolName: 'test-tool', subject: { kind: 'test' }, rawArgs: '{}', viewCursor: 'approval-open' });
      return { status: 'accepted', turnId: params.commandId };
    },
    'approval/decide': (params, rpc) => {
      assert.deepEqual(params.requirementId, requirement(stage));
      assert.equal(params.choiceId, 'allow-once-from-host');
      if (stage++ === 1) rpc.send('approval/updated', { sessionId: params.sessionId, approvalId: 'approval1', currentRequirementId: requirement(2), availableChoices: choices, subject: { kind: 'test' }, viewCursor: 'approval-stage-2' });
      else rpc.send('userInput/requested', { sessionId: params.sessionId, turnId: currentTurn.commandId, userInputId: 'question1', questions: [{ id: 'when', question: 'When?', options: [{ label: 'Today' }, { label: 'Tomorrow' }], selection: { mode: 'single' } }], viewCursor: 'question-open' });
      return { status: 'accepted', terminal: stage > 2 };
    },
    'userInput/answer': (params, rpc) => {
      assert.deepEqual(params.answers, [{ questionId: 'when', freeText: 'Next week' }]);
      finishMuse(rpc, currentTurn, 'Approved and answered');
      return { status: 'accepted', userInputId: 'question1' };
    },
  });
  const run = runInput(), events = [];
  const ongoing = fixture.adapter.start(run, event => events.push(event));
  await until(() => events.some(event => event.type === 'attention'));
  const first = events.find(event => event.type === 'attention').attention;
  await assert.rejects(fixture.adapter.respond(run, { attentionId: first.id, decision: 'made-up-choice' }), { code: 'invalid_decision' });
  await fixture.adapter.respond(run, { attentionId: first.id, decision: 'allow-once-from-host' });
  const second = events.filter(event => event.type === 'attention').at(-1).attention;
  assert.notEqual(first.id, second.id);
  await assert.rejects(fixture.adapter.respond(run, { attentionId: first.id, decision: 'allow-once-from-host' }), { code: 'attention_stale' });
  await fixture.adapter.respond(run, { attentionId: second.id, decision: 'allow-once-from-host' });
  await fixture.adapter.respond(run, { attentionId: 'question1', answers: { when: 'Next week' } });
  await ongoing;
  assert.equal(events.at(-1).text, 'Approved and answered');
});

test('Muse cancellation waits for official terminal and cancels a prompt admitted after the stop click', async t => {
  let admit;
  const fixture = museFixture(t, {
    'turn/start': params => new Promise(resolve => { admit = () => resolve({ status: 'accepted', turnId: params.commandId }); }),
    'turn/interrupt': (params, rpc) => {
      rpc.send('turn/completed', { sessionId: params.sessionId, turnId: params.turnId, terminal: 'cancelled', viewCursor: 'cancelled' });
      return { status: 'accepted', turnId: params.turnId };
    },
  });
  const run = runInput(), events = [];
  const ongoing = fixture.adapter.start(run, event => events.push(event));
  await until(() => !!admit);
  const beforeAck = await fixture.adapter.cancel(run);
  assert.equal(beforeAck.remoteStopped, false);
  admit();
  await ongoing;
  assert.equal(fixture.transports[0].calls.filter(call => call.method === 'turn/interrupt').length, 1);
  assert.equal(events.at(-1).type, 'interrupted');
});

test('Muse status validates app-owned credential shape and expiry without exposing the credential', async t => {
  const fixture = museFixture(t, {}, { offlineEcho: false });
  assert.equal((await fixture.adapter.status()).readiness, 'needs_login');
  const authFile = path.join(fixture.options.dataDir, 'profile', 'muse', 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ providers: { meta: { mechanism: 'oauth', access_token: 'local-fixture-not-a-real-token', expires_at: Date.now() / 1000 + 3600 } } }));
  const ready = await fixture.adapter.status();
  assert.equal(ready.readiness, 'ready');
  assert.match(ready.message, /资料已保存/);
  assert.equal(JSON.stringify(ready).includes('local-fixture-not-a-real-token'), false);
  fs.writeFileSync(authFile, JSON.stringify({ providers: { meta: { mechanism: 'oauth', access_token: 'local-fixture-not-a-real-token', expires_at: 1 } } }));
  assert.equal((await fixture.adapter.status()).readiness, 'needs_login');
});

test('Muse accepts the real flat OAuth schema and leaves refreshable expiration to the official runtime', async t => {
  const fixture = museFixture(t, {}, { offlineEcho: false });
  const authFile = path.join(fixture.options.dataDir, 'profile', 'muse', 'auth.json');
  const write = meta => fs.writeFileSync(authFile, JSON.stringify({ schema_version: 1, providers: { meta } }));
  write({ access_token: 'offline-access', expires_at: Date.now() / 1000 + 3600 });
  assert.equal((await fixture.adapter.status()).readiness, 'ready');
  write({ mechanism: 'oauth', access_token: 'offline-access', refresh_token: 'offline-refresh', expires_at: 1 });
  assert.equal((await fixture.adapter.status()).readiness, 'ready');
  write({ mechanism: 'oauth', access_token: '', api_key: 'offline-key', expires_at: 1 });
  assert.equal((await fixture.adapter.status()).readiness, 'ready');
  write({ mechanism: 'unknown', access_token: 'offline-access', api_key: 'offline-key' });
  assert.equal((await fixture.adapter.status()).readiness, 'needs_login');
});

function fakeLoginProcess(onInput) {
  const child = new EventEmitter();
  child.pid = 71; child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.inputs = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { child.inputs.push(String(chunk)); onInput?.(String(chunk), child); done(); } });
  child.kill = () => { if (child.exitCode === null) { child.exitCode = 1; child.emit('exit', 1); } };
  return child;
}

test('Muse login keeps stdin open and parses only complete official URLs across output chunks', async t => {
  const child = fakeLoginProcess(); let invocation;
  const fixture = museFixture(t, {}, { offlineEcho: false, spawnProcess: (command, args, settings) => { invocation = { command, args, settings }; return child; } });
  const starting = fixture.adapter.login('start');
  child.stdout.write('Open this page to sign in:\n  https://auth.me');
  assert.equal((await fixture.adapter.login('status')).url, undefined);
  child.stdout.write('ta.com/oauth/device/?code=ABCD-');
  assert.equal((await fixture.adapter.login('status')).url, undefined);
  child.stdout.write('EFGH\nconfirm this code matches:\n  ABCD-EFGH\n');
  const result = await starting;
  assert.deepEqual(invocation.args, ['login']); assert.equal(invocation.settings.stdio[0], 'pipe');
  assert.equal(result.url, 'https://auth.meta.com/oauth/device/?code=ABCD-EFGH');
  assert.equal(result.userCode, 'ABCD-EFGH'); assert.equal(result.browserOpened, false);
  assert.equal(result.state, 'pending'); assert.equal(child.stdin.writableEnded, false);
});

test('Muse login rejects misleading URLs and never returns raw runtime stderr', async t => {
  const child = fakeLoginProcess();
  const fixture = museFixture(t, {}, { offlineEcho: false, spawnProcess: () => child });
  const starting = fixture.adapter.login('start');
  child.stderr.write('private-token https://auth.meta.com.attacker.test/login\nhttps://password:private@auth.meta.com/oauth/\nhttps://meta.ai:8443/\nhttps://auth.meta.com/oauth/?access_token=private\n');
  const waiting = await starting;
  assert.equal(waiting.url, undefined); assert.equal(JSON.stringify(waiting).includes('private'), false);
  child.exitCode = 1; child.emit('exit', 1);
  const failed = await fixture.adapter.login('status');
  assert.equal(failed.state, 'failed'); assert.equal(failed.diagnostic.stage, 'authorization');
  assert.equal(JSON.stringify(failed).includes('private'), false);
});

test('Muse official API Key is written through CLI stdin into only the app-owned profile', async t => {
  let invocation, child;
  const fixture = museFixture(t, {}, { offlineEcho: false, spawnProcess: (command, args, settings) => {
    invocation = { command, args, settings };
    child = fakeLoginProcess((input, process) => {
      fs.writeFileSync(path.join(settings.env.XDG_CONFIG_HOME, 'muse', 'auth.json'), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: input.trim() } } }));
      process.stdout.write('private-api-key'); process.stderr.write('private-api-key');
      process.exitCode = 0; process.emit('exit', 0);
    });
    return child;
  } });
  const result = await fixture.adapter.configure({ apiKey: ' private-api-key ' });
  assert.deepEqual(invocation.args, ['auth', 'set', '--api-key-stdin']);
  assert.equal(invocation.settings.env.XDG_CONFIG_HOME, path.join(fixture.options.dataDir, 'profile'));
  assert.equal(invocation.settings.env.MUSE_AUTH_PATH, undefined);
  assert.equal(invocation.settings.env.META_API_KEY, undefined); assert.equal(invocation.settings.shell, false);
  assert.equal(JSON.stringify(invocation).includes('private-api-key'), false);
  assert.deepEqual(child.inputs, ['private-api-key\n']); assert.equal(result.readiness, 'ready');
  assert.equal(JSON.stringify(result).includes('private-api-key'), false);
  await fixture.adapter.login('logout');
  assert.equal(fs.existsSync(path.join(invocation.settings.env.XDG_CONFIG_HOME, 'muse', 'auth.json')), false);
});

test('Muse rejects malformed keys before spawning and redacts CLI save failures', async t => {
  let spawned = 0;
  const fixture = museFixture(t, {}, { offlineEcho: false, spawnProcess: () => {
    spawned++;
    return fakeLoginProcess((_input, child) => { child.stderr.write('private-key detail'); child.exitCode = 1; child.emit('exit', 1); });
  } });
  await assert.rejects(fixture.adapter.configure({ apiKey: 'secret\nsecond-line' }), { code: 'invalid_api_key' });
  assert.equal(spawned, 0);
  await assert.rejects(fixture.adapter.configure({ apiKey: 'private-key' }), failure => failure.code === 'api_key_save_failed' && !failure.message.includes('private-key'));
  assert.equal((await fixture.adapter.status()).readiness, 'needs_login');
});

test('Muse logout terminates an in-flight official key save before clearing the app auth file', async t => {
  let child;
  const fixture = museFixture(t, {}, { offlineEcho: false, spawnProcess: () => { child = fakeLoginProcess(); return child; } });
  const configuring = fixture.adapter.configure({ apiKey: 'private-key' });
  const rejected = assert.rejects(configuring, failure => ['api_key_save_failed', 'configuration_cancelled'].includes(failure.code));
  await until(() => child?.inputs.length === 1);
  const loggedOut = await fixture.adapter.login('logout'); await rejected;
  assert.equal(loggedOut.state, 'idle'); assert.notEqual(child.exitCode, null);
  assert.equal((await fixture.adapter.status()).readiness, 'needs_login');
});

test('Muse refuses a different protocol fingerprint or a foreign profile before sending a prompt', async t => {
  for (const override of [
    { schema: { fingerprint: 'sha256:unexpected' }, museHome: '/foreign' },
    { schema: { fingerprint: MUSE_SCHEMA_FINGERPRINT }, museHome: '/foreign' },
  ]) {
    const fixture = museFixture(t, { initialize: () => override });
    await assert.rejects(fixture.adapter.start(runInput(), () => {}), error => ['protocol_mismatch', 'profile_not_isolated'].includes(error.code));
    assert.equal(fixture.transports[0].calls.some(call => call.method === 'turn/start'), false);
  }
});

function deepseekFixture(t, handlers = {}, extra = {}) {
  const env = environment(t), transports = [];
  const adapter = createDeepSeekAdapter({ ...env.options, ...extra, transportFactory: settings => {
    const rpc = new MockRpc(settings, async (method, params, transport) => {
      if (handlers[method]) return handlers[method](params, transport);
      if (method === 'initialize') return { initialized: true, sdkVersion: '0.2.1rc2', runtimeVersion: '0.2.1rc2' };
      if (method === 'session/recover') return { restored: true, sessionId: params.sessionId };
      if (method === 'stop' || method === 'shutdown') return { stopped: true };
      return {};
    });
    transports.push(rpc); return rpc;
  } });
  t.after(() => adapter.close());
  return { ...env, adapter, transports };
}
function deepseekReply(params, rpc, answer = 'Official Harness answer', reason = 'stop') {
  rpc.send('run/accepted', { sessionId: params.sessionId, messageId: 'official-message-id' });
  rpc.send('runtime/notification', { method: 'session.event', payload: { sessionId: params.sessionId, event: { type: 'assistant/message', data: { message: { id: 'answer1', content: [{ type: 'text', text: answer }] } } } } });
  return { sessionId: params.sessionId, finalResponse: answer, finishReason: reason, accepted: true };
}

test('DeepSeek uses pinned official SDK worker and strips shell, file tools and uploads', async t => {
  const fixture = deepseekFixture(t, { 'session/run': (params, rpc) => deepseekReply(params, rpc) });
  const events = [];
  await fixture.adapter.start({ ...runInput(), agentId: 'deepseek-harness' }, event => events.push(event));
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).text, 'Official Harness answer');
  const rpc = fixture.transports[0], init = rpc.calls.find(call => call.method === 'initialize').params;
  assert.equal(init.apiKey, 'offline-test-key-never-real');
  assert.equal(rpc.settings.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(rpc.settings.args[0], '-I');
  assert.equal(JSON.stringify(events).includes('offline-test-key-never-real'), false);
  assert.equal(JSON.stringify(fixture.options.getConfig()).includes('offline-test-key-never-real'), false);
  const patch = JSON.parse(fs.readFileSync(init.patchPath, 'utf8'));
  for (const id of DEEPSEEK_DISABLED_PLUGINS) assert.equal(patch.find(row => row.id === id)?.disabled, true);
  assert.equal(patch.find(row => row.id === 'session-log-deepseek').config.enabled, false);
  const workerPath = fileURLToPath(new URL('../runtime/python/deepseek_worker.py', import.meta.url));
  assert.match(fs.readFileSync(workerPath, 'utf8'), /profile="sdk-minimal"/);
  assert.equal(rpc.calls.filter(call => call.method === 'shutdown').length, 1);
});

test('DeepSeek followup resumes the same official session; recovery does not submit input', async t => {
  const fixture = deepseekFixture(t, { 'session/run': (params, rpc) => deepseekReply(params, rpc) });
  const firstEvents = [];
  await fixture.adapter.start(runInput('first'), event => firstEvents.push(event));
  const sessionId = firstEvents.find(event => event.type === 'started').sessionId;
  await fixture.adapter.start({ ...runInput('followup'), sessionId }, () => {});
  assert.equal(fixture.transports[1].calls.find(call => call.method === 'session/run').params.resume, true);
  const events = [];
  await fixture.adapter.recover({ ...runInput('recovery'), sessionId, deliveryStatus: 'accepted' }, event => events.push(event));
  assert.equal(fixture.transports[2].calls.some(call => call.method === 'session/run'), false);
  assert.equal(fixture.transports[2].calls.some(call => call.method === 'session/recover'), true);
  assert.equal(events.at(-1).type, 'interrupted');
});

test('DeepSeek only reports remote stop after the official worker shutdown receipt', async t => {
  let finishRun;
  const fixture = deepseekFixture(t, {
    'session/run': (params, rpc) => {
      rpc.send('run/accepted', { sessionId: params.sessionId, messageId: 'official-message-id' });
      return new Promise(resolve => { finishRun = () => resolve({ sessionId: params.sessionId, finishReason: 'interrupted', finalResponse: '', accepted: true }); });
    },
    stop: () => { finishRun(); return { stopped: true }; },
  });
  const run = runInput(), events = [];
  const ongoing = fixture.adapter.start(run, event => events.push(event));
  await until(() => !!finishRun);
  assert.equal((await fixture.adapter.cancel(run)).remoteStopped, true);
  await ongoing;
  assert.equal(events.at(-1).type, 'interrupted');
});

test('DeepSeek SDK failures redact upstream error text and unknown terminal states never become success', async t => {
  const broken = deepseekFixture(t, { initialize: () => { throw new Error('sensitive-api-key-in-upstream-error'); } });
  const failedEvents = [];
  await broken.adapter.start(runInput('error'), event => failedEvents.push(event));
  assert.equal(failedEvents.at(-1).type, 'interrupted');
  assert.equal(JSON.stringify(failedEvents).includes('sensitive-api-key'), false);
  const unknown = deepseekFixture(t, { 'session/run': (params, rpc) => deepseekReply(params, rpc, 'A partial answer', 'unknown_future_outcome') });
  const unknownEvents = [];
  await unknown.adapter.start(runInput('unknown'), event => unknownEvents.push(event));
  assert.equal(unknownEvents.at(-1).type, 'failed');
});

test('cancel before adapter dispatch never submits a new prompt', async t => {
  for (const fixture of [museFixture(t), deepseekFixture(t)]) {
    const run = { ...runInput('cancelled-before-send'), deliveryStatus: 'pending' };
    assert.equal((await fixture.adapter.cancel(run)).remoteStopped, true);
    const events = [];
    await fixture.adapter.start(run, event => events.push(event));
    assert.equal(fixture.transports.length, 0);
    assert.equal(events.at(-1).type, 'interrupted');
  }
});
