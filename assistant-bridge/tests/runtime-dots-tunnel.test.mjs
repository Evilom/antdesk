import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDotsTunnel } from '../runtime/dots-tunnel.mjs';

const ID = 'tunnel_0123456789abcdef0123456789abcdef';
const OTHER_ID = 'tunnel_ab12_abcdefghijklmnopqrstuvwxyz012345';
const KEY = 'sk-runtime-key-secret-fixture-0001';
const TOKEN = 'omdot-scoped-token-fixture-0002';
const VERSION = '0.0.19+01d67bb4da0d8359b808b4761f8db171ab682cd7';
const healthy = () => ({ schema_version: 1, live: true, ready: true,
  components: { 'control-plane': { status: 'ok', state: 'polling', details: { successful_polls: 1 } } } });

function fakeChild({ stubborn = false, ignoresTerminate = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 1234; child.exitCode = null; child.kills = [];
  child.finish = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code; child.stdout.end(); child.stderr.end();
    child.emit('exit', code, null); child.emit('close', code, null);
  };
  child.kill = signal => { child.kills.push(signal || 'SIGTERM'); if (!stubborn && (!ignoresTerminate || signal === 'SIGKILL')) queueMicrotask(() => child.finish()); return true; };
  return child;
}

async function fixture(t, settings = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'antdesk-dots-tunnel-'));
  const toolsDir = path.join(directory, 'tools'), dataDir = path.join(directory, 'data');
  await mkdir(path.join(toolsDir, 'dots-tunnel'), { recursive: true });
  if (!settings.missingBinary) await writeFile(path.join(toolsDir, 'dots-tunnel', 'tunnel-client.exe'), 'fixture-only');
  const config = { ...(settings.unconfigured ? {} : { tunnelId: ID }) };
  const secrets = settings.unconfigured ? {} : { tunnelApiKey: KEY };
  const calls = [], http = [], savedConfig = [], savedSecrets = [], children = [];
  const state = { readyText: 'ready\n', readyStatus: 200, health: healthy(), target: { url: 'http://127.0.0.1:24249/mcp', token: TOKEN }, writeHealth: true };
  const spawnImpl = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = fakeChild(settings.child);
    if (args[0] === '--version') {
      queueMicrotask(() => { child.stdout.write(settings.versionText ?? VERSION + '\n'); child.finish(settings.versionCode ?? 0); });
    } else {
      children.push(child);
      if (settings.spawnError) throw new Error('private-spawn-secret-' + KEY);
      if (state.writeHealth) writeFileSync(args[args.indexOf('--health.url-file') + 1], state.healthUrl || `http://127.0.0.1:${40000 + children.length}`);
      settings.onSpawn?.(child, args, opts);
    }
    return child;
  };
  const fetchImpl = async (url, init) => {
    http.push({ url, init });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.method, 'GET');
    assert.ok(!JSON.stringify(init).includes(KEY)); assert.ok(!JSON.stringify(init).includes(TOKEN));
    if (state.fetch) return state.fetch(url, init);
    if (url.endsWith('/readyz')) return new Response(state.readyText, { status: state.readyStatus });
    assert.ok(url.endsWith('/health?details=true'));
    return Response.json(state.health);
  };
  const options = { toolsDir, dataDir,
    getConfig: () => ({ ...config }), setConfig: patch => { savedConfig.push(patch); Object.assign(config, patch); },
    getSecret: key => secrets[key], setSecret: (key, value) => { savedSecrets.push({ key, value }); secrets[key] = value; },
    getUpstream: () => state.target, spawnImpl, fetchImpl,
    pollMs: 60000, probeTimeoutMs: 50, readyTimeoutMs: 60000, stopTimeoutMs: 50, versionTimeoutMs: 100,
    ...settings.options };
  const tunnel = createDotsTunnel(options);
  t.after(async () => { for (const child of children) child.finish(); await tunnel.close(); await rm(directory, { recursive: true, force: true }); });
  return { tunnel, directory, dataDir, options, config, secrets, calls, http, children, state, savedConfig, savedSecrets };
}

test('status checks installation without starting a tunnel or reading unrelated credentials', async t => {
  const f = await fixture(t, { unconfigured: true });
  assert.deepEqual(await f.tunnel.status(), { state: 'idle', installed: true, version: VERSION, tunnelId: '', configured: false, error: null, startedAt:null });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args, ['--version']);
  assert.equal(f.http.length, 0); assert.equal(f.children.length, 0);
  const result = await f.tunnel.start(); assert.equal(result.state, 'failed'); assert.equal(result.configured, false);
  assert.equal(f.children.length, 0);
});

test('configuration stores only the ID in config and sends the key through the secret callback', async t => {
  const f = await fixture(t, { unconfigured: true });
  const result = await f.tunnel.configure({ tunnelId: OTHER_ID, tunnelApiKey: KEY });
  assert.equal(result.state, 'idle'); assert.equal(result.configured, true); assert.equal(result.tunnelId, OTHER_ID);
  assert.deepEqual(f.savedConfig, [{ tunnelId: OTHER_ID }]);
  assert.deepEqual(f.savedSecrets, [{ key: 'tunnelApiKey', value: KEY }]);
  assert.equal(f.children.length, 0); assert.equal(f.http.length, 0);
  assert.ok(!JSON.stringify(result).includes(KEY));
  await assert.rejects(f.tunnel.configure({ tunnelId: ID }), { code: 'invalid_tunnel_key' });
  await assert.rejects(f.tunnel.configure({ tunnelId: 'tunnel_BAD', tunnelApiKey: KEY }), { code: 'invalid_tunnel_id' });
  await assert.rejects(f.tunnel.configure({ tunnelId: ID, tunnelApiKey: 'sk-secret\r\nheader-value' }), { code: 'invalid_tunnel_key' });
});

test('runtime uses fixed official origin, isolated flags and scoped MCP env auth without credential files', async t => {
  const inherited = { OPENAI_API_KEY: 'unrelated-admin-secret', CONTROL_PLANE_BASE_URL: 'https://example.invalid',
    MCP_EXTRA_HEADERS: 'Authorization: unrelated-admin-secret', TUNNEL_CLIENT_CONFIG: 'unrelated-config.yaml', LOG_HTTP_RAW_UNSAFE: 'true', AWS_SECRET_ACCESS_KEY: 'unrelated-aws-secret' };
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const f = await fixture(t); const result = await f.tunnel.start();
  assert.equal(result.state, 'ready'); assert.equal(result.version, VERSION);
  const call = f.calls.find(call => call.args[0] === 'run');
  assert.equal(call.opts.shell, false); assert.equal(call.opts.windowsHide, true);
  assert.equal(call.args[call.args.indexOf('--control-plane.base-url') + 1], 'https://api.openai.com');
  assert.equal(call.args[call.args.indexOf('--control-plane.api-key') + 1], 'env:CONTROL_PLANE_API_KEY');
  assert.equal(call.args[call.args.indexOf('--mcp.extra-headers') + 1], 'Authorization: env:ANTDESK_DOT_MCP_AUTH');
  assert.equal(call.args[call.args.indexOf('--mcp.discovery-extra-headers') + 1], 'Authorization: env:ANTDESK_DOT_MCP_AUTH');
  assert.ok(call.args.includes('X-AntDesk-Discovery: 1'));assert.ok(result.startedAt>0);
  assert.equal(call.opts.env.CONTROL_PLANE_API_KEY, KEY); assert.equal(call.opts.env.ANTDESK_DOT_MCP_AUTH, 'Bearer ' + TOKEN);
  for (const key of Object.keys(inherited)) assert.equal(Object.hasOwn(call.opts.env, key), false);
  assert.ok(!JSON.stringify(call.args).includes(KEY)); assert.ok(!JSON.stringify(call.args).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes(TOKEN));
  const runDirectory = path.dirname(call.args[call.args.indexOf('--health.url-file') + 1]);
  assert.deepEqual((await readdir(runDirectory)).sort(), ['health-url', 'profiles']);
  assert.equal((await readdir(path.join(runDirectory, 'profiles'))).length, 0);
  assert.ok(!(await readFile(path.join(runDirectory, 'health-url'), 'utf8')).includes(KEY));
});

test('running process and startup readiness cannot substitute for successful control-plane health', async t => {
  const f = await fixture(t);
  f.state.health.components['control-plane'] = { status: 'unknown', state: 'not_observed' };
  assert.equal((await f.tunnel.start()).state, 'starting');
  f.state.health.components['control-plane'] = { status: 'degraded', reason_code: 'http_403', details: { raw: KEY } };
  const notReady = await f.tunnel.status(); assert.equal(notReady.state, 'starting'); assert.ok(!JSON.stringify(notReady).includes(KEY));
  f.state.health = healthy(); assert.equal((await f.tunnel.status()).state, 'ready');
  f.state.readyStatus = 503; f.state.readyText = KEY;
  const degraded = await f.tunnel.status(); assert.equal(degraded.state, 'failed'); assert.ok(!JSON.stringify(degraded).includes(KEY));
  f.state.readyStatus = 200; f.state.readyText = 'ready';
  assert.equal((await f.tunnel.status()).state, 'ready'); assert.equal(f.children.length, 1);
});

test('startup probe auth warnings, malformed health and unsupported schemas never report ready', async t => {
  const f = await fixture(t, { options: { readyTimeoutMs: 0 } });
  f.state.readyText = 'ready (mcp initialize requires auth: private-detail)';
  assert.equal((await f.tunnel.start()).state, 'failed');
  f.state.readyText = 'ready'; f.state.health.schema_version = 2;
  assert.equal((await f.tunnel.status()).state, 'failed');
  f.state.health = { ready: true, live: true, schema_version: 1 };
  assert.equal((await f.tunnel.status()).state, 'failed');
  f.state.health = healthy(); assert.equal((await f.tunnel.status()).state, 'ready');
});

test('untrusted health URL cannot redirect probes outside the spawned loopback listener', async t => {
  const f = await fixture(t); f.state.healthUrl = 'https://example.invalid/collect?key=' + KEY;
  const result = await f.tunnel.start(); assert.equal(result.state, 'failed'); assert.equal(f.http.length, 0);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.ok(!JSON.stringify(result).includes('example.invalid'));
  assert.ok(f.children[0].kills.length > 0);
});

test('upstream is limited to the local MCP path with a separate nonempty scoped credential', async t => {
  const f = await fixture(t);
  for (const target of [{ url: 'https://example.invalid/mcp', token: TOKEN }, { url: 'http://127.0.0.1:24249/admin', token: TOKEN },
    { url: 'http://127.0.0.1:24249/mcp?token=' + TOKEN, token: TOKEN }, { url: 'http://127.0.0.1:24249/mcp', token: '' }]) {
    f.state.target = target; const result = await f.tunnel.start(); assert.equal(result.state, 'failed'); assert.ok(!JSON.stringify(result).includes(TOKEN));
  }
  assert.equal(f.children.length, 0); assert.equal(f.http.length, 0);
});

test('repeat start is idempotent, rotation replaces the child, and old health files are not reused', async t => {
  const f = await fixture(t);
  await f.tunnel.start(); await f.tunnel.start(); assert.equal(f.children.length, 1);
  const first = f.calls.find(call => call.args[0] === 'run');
  f.state.target.token = TOKEN + '-rotated'; f.state.writeHealth = false;
  assert.equal((await f.tunnel.start()).state, 'starting'); assert.equal(f.children.length, 2);
  assert.ok(f.children[0].kills.length > 0);
  const runs = f.calls.filter(call => call.args[0] === 'run');
  assert.notEqual(runs[0].opts.cwd, runs[1].opts.cwd);
  await assert.rejects(readFile(first.args[first.args.indexOf('--health.url-file') + 1]), { code: 'ENOENT' });
  assert.equal((await f.tunnel.stop()).state, 'idle'); assert.equal((await readdir(f.dataDir)).length, 0);
});

test('stop wins over an in-flight readiness result and close prevents a restart', async t => {
  const f = await fixture(t); await f.tunnel.start();
  let release; let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  f.state.fetch = async url => { entered(); return new Promise(resolve => { release = () => resolve(url.endsWith('/readyz') ? new Response('ready') : Response.json(healthy())); }); };
  const check = f.tunnel.status(); await inside;
  const stopping = f.tunnel.stop(); release();
  // If the first probe completes after cancellation, no second request should be needed.
  f.state.fetch = null;
  await stopping; await check;
  assert.equal((await f.tunnel.status()).state, 'idle');
  await f.tunnel.close(); await assert.rejects(f.tunnel.start(), { code: 'tunnel_closed' });
});

test('process errors and stderr are sanitized; a subsequent explicit start can recover', async t => {
  const f = await fixture(t); await f.tunnel.start();
  f.children[0].stderr.write('Bearer ' + KEY + ' ' + TOKEN);
  f.children[0].stdout.write('raw token ' + TOKEN);
  f.children[0].finish(1);
  const failed = await f.tunnel.status(); assert.equal(failed.state, 'failed');
  assert.ok(!JSON.stringify(failed).includes(KEY)); assert.ok(!JSON.stringify(failed).includes(TOKEN));
  assert.equal((await f.tunnel.start()).state, 'ready'); assert.equal(f.children.length, 2);
});

test('changing saved tunnel stops the old child and restores only configuration after reconstruction', async t => {
  const f = await fixture(t); await f.tunnel.start();
  assert.equal((await f.tunnel.configure({ tunnelId: OTHER_ID, tunnelApiKey: KEY + '-replacement' })).state, 'idle');
  assert.ok(f.children[0].kills.length > 0);
  await f.tunnel.close();
  const restored = createDotsTunnel(f.options); t.after(() => restored.close());
  const status = await restored.status(); assert.equal(status.configured, true); assert.equal(status.tunnelId, OTHER_ID); assert.equal(status.state, 'idle');
  assert.equal(f.children.length, 1);
  assert.equal((await restored.start()).state, 'ready'); assert.equal(f.children.length, 2);
});

test('missing or unverifiable official binary fails without launching a tunnel', async t => {
  const missing = await fixture(t, { missingBinary: true });
  const absent = await missing.tunnel.start(); assert.equal(absent.installed, false); assert.equal(absent.state, 'failed'); assert.equal(missing.calls.length, 0);
  const malformed = await fixture(t, { versionText: 'private failure ' + KEY });
  const failed = await malformed.tunnel.start(); assert.equal(failed.state, 'failed'); assert.equal(failed.version, null); assert.equal(malformed.children.length, 0);
  assert.ok(!JSON.stringify(failed).includes(KEY));
});

test('termination waits for confirmed exit and never starts a second child while the first is stuck', async t => {
  const force = await fixture(t, { child: { ignoresTerminate: true }, options: { stopTimeoutMs: 10 } });
  await force.tunnel.start(); assert.equal((await force.tunnel.stop()).state, 'idle');
  assert.deepEqual(force.children[0].kills, ['SIGTERM', 'SIGKILL']);
  const stuck = await fixture(t, { child: { stubborn: true }, options: { stopTimeoutMs: 10 } });
  await stuck.tunnel.start(); assert.equal((await stuck.tunnel.stop()).state, 'failed');
  stuck.state.target.token = TOKEN + '-changed';
  assert.equal((await stuck.tunnel.start()).state, 'failed'); assert.equal(stuck.children.length, 1);
});
