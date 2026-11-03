import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { createMuseBrowserLogin, museLoginDiagnostic } from '../runtime/muse-browser-login.mjs';

const cookie = (name = 'hatch_sess', value = 'offline-session', domain = '.muse.ai', extra = {}) => ({ name, value, domain, path: '/', expires: -1, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { const deadline = Date.now() + 1500; while (Date.now() < deadline) { if (predicate()) return; await delay(2); } assert.fail('The expected asynchronous operation did not begin.'); }
class BrowserContext extends EventEmitter {
  constructor(rows) { super(); this.rows = rows; this.closeCalls = 0; this.reads = []; this.navigation = []; }
  pages() { return [{ goto: async (url, settings) => { this.navigation.push({ url, settings }); } }]; }
  async newPage() { assert.fail('The existing dedicated page should be reused.'); }
  async cookies(url) { this.reads.push(url); return this.rows; }
  async close() { this.closeCalls++; this.emit('close'); }
}
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-muse-login-test-'));
  const dataDir = path.join(root, 'provider'), toolsDir = path.join(root, 'tools');
  const profileDir = path.join(dataDir, 'browser-profile');
  const foreignDir = path.join(root, 'unrelated-browser');
  fs.mkdirSync(foreignDir); fs.writeFileSync(path.join(foreignDir, 'untouched'), 'unrelated user session');
  const context = new BrowserContext(extra.rows || []), launches = [], verified = [], writes = [], timers = new Map();
  let time = 1000000, sequence = 0, stored = extra.stored;
  const helper = createMuseBrowserLogin({ dataDir, toolsDir, now: () => time, maxWaitMs: 60000, verifyTimeoutMs: 10000,
    scheduler: { setTimeout(fn, ms) { const token = { id: ++sequence, unref() {} }; timers.set(token, { fn, ms }); return token; }, clearTimeout(token) { timers.delete(token); } },
    getSecret: key => { assert.equal(key, 'cookies'); return stored; },
    setSecret: async (key, value) => { writes.push({ key, value }); if (extra.setSecret) await extra.setSecret(key, value, writes.length); stored = value; },
    verifyCookies: async (header, options) => { verified.push(header); return extra.verify ? extra.verify(header, options) : { ok: true }; },
    launch: async (profile, settings) => { launches.push({ profile, settings }); return extra.launch ? extra.launch(profile, settings, context) : context; },
    ...extra.options,
  });
  t.after(async () => { await helper.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { helper, context, launches, verified, writes, timers, root, dataDir, profileDir, foreignDir,
    stored: () => stored, advance: milliseconds => { time += milliseconds; },
    async open() { const response = await helper.login('start'); await helper.tick(); return response; } };
}

test('constructing, reading status and cancelling never start a browser or create a profile', async t => {
  const f = fixture(t);
  assert.equal((await f.helper.login('status')).state, 'idle');
  assert.equal((await f.helper.login('cancel')).state, 'idle');
  assert.equal(f.launches.length, 0);
  assert.equal(f.verified.length, 0);
  assert.equal(fs.existsSync(f.profileDir), false);
  assert.equal(fs.readFileSync(path.join(f.foreignDir, 'untouched'), 'utf8'), 'unrelated user session');
});

test('explicit login opens exactly one headed browser using only the dedicated profile', async t => {
  const f = fixture(t);
  const first = await f.helper.login('start');
  assert.equal(first.state, 'pending');
  assert.equal(first.browserOpened, true);
  await f.helper.login('start');
  await f.helper.tick();
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].profile, f.profileDir);
  assert.equal(f.launches[0].settings.headless, false);
  assert.equal(f.launches[0].settings.acceptDownloads, false);
  assert.equal(f.launches[0].settings.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(f.launches[0].settings.args.some(arg => /stealth|disable-blink|automationcontrolled/i.test(arg)), false);
  assert.deepEqual(f.context.navigation.map(item => item.url), ['https://muse.ai/']);
  assert.deepEqual(f.context.reads, ['https://muse.ai/']);
  assert.equal((await f.helper.login('status')).state, 'pending');
  assert.equal(f.writes.length, 0);
});

test('origin cookie collection also rejects foreign domains and verifies before saving', async t => {
  const f = fixture(t, { rows: [cookie(), cookie('aux', 'local-helper', 'api.muse.ai'), cookie('cf', 'verified', 'muse.ai'),
    cookie('evil', 'foreign-secret', '.muse.ai.attacker.test'), cookie('other', 'foreign-secret', 'notmuse.ai'),
    cookie('third-party', 'foreign-secret', '.google.com'), cookie('expired', 'old', 'muse.ai', { expires: 1 })],
    verify: async header => { assert.equal(f.writes.length, 0); assert.equal(header, 'hatch_sess=offline-session; aux=local-helper; cf=verified'); return { ok: true }; } });
  await f.open();
  const status = await f.helper.login('status');
  assert.equal(status.state, 'ready');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].key, 'cookies');
  assert.equal(f.stored(), 'hatch_sess=offline-session; aux=local-helper; cf=verified');
  assert.equal(f.context.closeCalls, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(JSON.stringify(status).includes('offline-session'), false);
  assert.equal(JSON.stringify(status).includes('foreign-secret'), false);
});

test('a session on a lookalike or unrelated domain can never authenticate Muse', async t => {
  for (const domain of ['muse.ai.attacker.test', 'notmuse.ai', 'muse-ai.test', '.google.com', '.muse.ai.', '']) {
    await t.test(domain || 'empty domain', async subtest => {
      const f = fixture(subtest, { rows: [cookie('hatch_sess', 'foreign-cookie', domain)] });
      await f.open();
      assert.equal((await f.helper.login('status')).state, 'pending');
      assert.equal(f.verified.length, 0);
      assert.equal(f.writes.length, 0);
    });
  }
});

test('invalid, expired and ambiguous session cookies never become credentials', async t => {
  for (const rows of [
    [cookie('hatch_sess', 'value\r\nInjected: secret')], [cookie('hatch_sess', 'one; other=secret')],
    [cookie('hatch_sess', 'old', '.muse.ai', { expires: 1 })], [cookie('hatch_sess', '')],
    [cookie(), cookie('hatch_sess', 'conflicting-account', 'muse.ai')],
  ]) {
    const f = fixture(t, { rows }); await f.open();
    assert.equal(f.verified.length, 0); assert.equal(f.writes.length, 0);
    await f.helper.login('cancel');
  }
});

test('verification rejection and upstream errors never save or expose cookies', async t => {
  for (const verify of [() => ({ ok: false }), () => ({ status: 'not-authenticated' }), () => { throw new Error('offline-session private-cookie'); }]) {
    const f = fixture(t, { rows: [cookie()], verify });
    await f.open();
    const result = await f.helper.login('status');
    assert.equal(result.state, 'failed');
    assert.equal(f.writes.length, 0);
    assert.equal(f.context.closeCalls, 1);
    assert.equal(JSON.stringify(result).includes('offline-session'), false);
    assert.equal(JSON.stringify(result).includes('private-cookie'), false);
  }
});

test('a personal VM that is starting preserves the browser/profile and is retried before saving', async t => {
  let attempts = 0;
  const f = fixture(t, { rows: [cookie()], verify: () => {
    if (++attempts === 1) throw Object.assign(new Error('hatch_sess=must-not-leak'), {
      data: { kind: 'GatewayError', stage: 'session', code: 'vm_unavailable', retryable: true, payload: 'must-not-leak' } });
    return { ok: true };
  } });
  await f.open();
  fs.writeFileSync(path.join(f.profileDir, 'owned-session'), 'preserved');
  const waiting = await f.helper.login('status');
  assert.equal(waiting.state, 'pending');
  assert.deepEqual(waiting.diagnostic, { stage: 'session', code: 'vm_unavailable', retryable: true });
  assert.equal(f.context.closeCalls, 0); assert.equal(f.writes.length, 0);
  assert.equal(JSON.stringify(waiting).includes('must-not-leak'), false);
  await f.helper.tick(); assert.equal(attempts, 1, 'polling must respect retry backoff');
  f.advance(5000); await f.helper.tick();
  assert.equal((await f.helper.login('status')).state, 'ready');
  assert.equal(attempts, 2); assert.equal(f.writes.length, 1);
  assert.equal(fs.readFileSync(path.join(f.profileDir, 'owned-session'), 'utf8'), 'preserved');
});

test('an early rejected browser cookie waits for authorization without resetting the profile', async t => {
  const f = fixture(t, { rows: [cookie()], verify: header => {
    if (header.includes('offline-session')) throw Object.assign(new Error('private detail'), {
      data: { kind: 'AuthError', stage: 'authorization', code: 'auth_required', httpStatus: 401 } });
    return { ok: true };
  } });
  await f.open();
  const waiting = await f.helper.login('status');
  assert.equal(waiting.state, 'pending'); assert.equal(waiting.diagnostic.code, 'auth_required');
  assert.equal(f.context.closeCalls, 0);
  f.advance(10000); await f.helper.tick(); assert.equal(f.verified.length, 1);
  f.context.rows = [cookie('hatch_sess', 'authorized-session')];
  await f.helper.tick();
  assert.equal((await f.helper.login('status')).state, 'ready');
  assert.equal(f.verified.length, 2); assert.equal(f.launches.length, 1);
});

test('transient verification retries are bounded and never erase the dedicated login', async t => {
  const f = fixture(t, { rows: [cookie()], options: { maxVerifyAttempts: 2 }, verify: () => {
    throw Object.assign(new Error('upstream body'), { data: { kind: 'AuthError', code: 'service_unavailable', stage: 'session', httpStatus: 503 } });
  } });
  await f.open(); fs.writeFileSync(path.join(f.profileDir, 'owned-session'), 'preserved');
  assert.equal((await f.helper.login('status')).state, 'pending');
  f.advance(5000); await f.helper.tick();
  const failed = await f.helper.login('status');
  assert.equal(failed.state, 'failed'); assert.equal(failed.diagnostic.httpStatus, 503);
  assert.equal(f.verified.length, 2); assert.equal(f.writes.length, 0); assert.equal(f.context.closeCalls, 1);
  assert.equal(fs.readFileSync(path.join(f.profileDir, 'owned-session'), 'utf8'), 'preserved');
  await f.helper.login('status'); await f.helper.tick(); assert.equal(f.launches.length, 1);
});

test('verification timeout aborts the current worker attempt but leaves login open for bounded retry', async t => {
  let verificationSignal;
  const result = deferred();
  const f = fixture(t, { rows: [cookie()], verify: (_header, { signal }) => { verificationSignal = signal; return result.promise; } });
  await f.helper.login('start'); const polling = f.helper.tick();
  await until(() => f.verified.length === 1);
  const timer = [...f.timers.values()].find(item => item.ms === 10000); assert.ok(timer);
  timer.fn(); await polling;
  const waiting = await f.helper.login('status');
  assert.equal(waiting.state, 'pending'); assert.equal(waiting.diagnostic.code, 'verification_timeout');
  assert.equal(verificationSignal.aborted, true); assert.equal(f.context.closeCalls, 0);
  result.resolve({ ok: true }); await nextTurn(); assert.equal(f.writes.length, 0);
});

test('public Muse diagnostics reject arbitrary stages, codes, values and exception strings', () => {
  const safe = museLoginDiagnostic({ data: { stage: 'private-session', code: 'private-token', httpStatus: 'private-cookie',
    retryable: true, kind: 'UnknownPrivateClass', message: 'private-password' } });
  assert.deepEqual(safe, { stage: 'verification', code: 'verification_failed', retryable: false });
  assert.deepEqual(museLoginDiagnostic({ data: { stage: 'authorization', code: 'rate_limited', httpStatus: 429, retryable: false } }),
    { stage: 'authorization', code: 'rate_limited', httpStatus: 429, retryable: true });
});

test('cancelling while gateway verification is pending closes only its browser and prevents late saves', async t => {
  const result = deferred();
  const f = fixture(t, { rows: [cookie()], verify: () => result.promise });
  await f.helper.login('start'); const tick = f.helper.tick();
  await until(() => f.verified.length === 1);
  assert.equal((await f.helper.login('cancel')).state, 'idle');
  await tick;
  assert.equal(f.context.closeCalls, 1); assert.equal(f.writes.length, 0);
  result.resolve({ ok: true }); await nextTurn();
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(path.join(f.foreignDir, 'untouched')), true);
});

test('a browser launch completing after cancellation is closed without navigation or cookie access', async t => {
  const launching = deferred();
  const f = fixture(t, { launch: () => launching.promise });
  await f.helper.login('start'); const tick = f.helper.tick();
  await until(() => f.launches.length === 1);
  await f.helper.login('cancel'); launching.resolve(f.context); await tick;
  assert.equal(f.context.closeCalls, 1);
  assert.equal(f.context.navigation.length, 0); assert.equal(f.context.reads.length, 0);
  assert.equal(f.writes.length, 0);
});

test('logout clears the helper credential and profile, keeping unrelated browser files intact', async t => {
  const f = fixture(t, { rows: [cookie()] });
  await f.open(); fs.writeFileSync(path.join(f.profileDir, 'owned-session'), 'dedicated login');
  const response = await f.helper.login('logout');
  assert.equal(response.state, 'idle');
  assert.equal(f.stored(), '');
  assert.equal(fs.existsSync(f.profileDir), false);
  assert.equal(fs.readFileSync(path.join(f.foreignDir, 'untouched'), 'utf8'), 'unrelated user session');
  assert.equal(f.context.closeCalls, 1);
  assert.equal(f.launches.length, 1);
});

test('shutdown during verification does not wait for the gateway or permit a new browser', async t => {
  const result = deferred();
  const f = fixture(t, { rows: [cookie()], verify: () => result.promise });
  await f.helper.login('start'); const tick = f.helper.tick(); await until(() => f.verified.length === 1);
  await f.helper.close(); await tick;
  assert.equal(f.context.closeCalls, 1);
  assert.equal((await f.helper.login('start')).state, 'failed');
  result.resolve({ ok: true }); await nextTurn();
  assert.equal(f.writes.length, 0); assert.equal(f.launches.length, 1);
});

test('saved credentials are passively verified without opening a browser or rewriting the secret', async t => {
  const f = fixture(t, { stored: 'hatch_sess=saved-session' });
  assert.equal((await f.helper.login('status')).state, 'pending');
  await f.helper.tick();
  assert.equal((await f.helper.login('status')).state, 'ready');
  assert.deepEqual(f.verified, ['hatch_sess=saved-session']);
  assert.equal(f.writes.length, 0); assert.equal(f.launches.length, 0);
  assert.equal(fs.existsSync(f.profileDir), false);
});

test('login polling has a deadline and never reopens a timed out browser', async t => {
  const f = fixture(t); await f.open();
  f.advance(60001);
  assert.equal((await f.helper.tick()).state, 'failed');
  assert.equal(f.context.closeCalls, 1); assert.equal(f.timers.size, 0);
  await f.helper.login('status'); await f.helper.tick();
  assert.equal(f.launches.length, 1); assert.equal(f.writes.length, 0);
});

test('closing the dedicated window stops polling and does not trigger another window', async t => {
  const f = fixture(t); await f.open();
  await f.context.close();
  assert.equal((await f.helper.login('status')).state, 'idle');
  assert.equal(f.timers.size, 0); assert.equal(f.launches.length, 1);
});

test('a profile symlink or junction is never followed into another browser directory', async t => {
  const f = fixture(t); fs.mkdirSync(f.dataDir, { recursive: true });
  try { fs.symlinkSync(f.foreignDir, f.profileDir, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('This host cannot create test links.'); return; } throw error; }
  await f.open();
  assert.equal((await f.helper.login('status')).state, 'failed');
  assert.equal(f.launches.length, 0);
  assert.equal(fs.readFileSync(path.join(f.foreignDir, 'untouched'), 'utf8'), 'unrelated user session');
});

test('an asynchronous secret write racing cancellation restores the prior credential', async t => {
  const writing = deferred();
  const f = fixture(t, { stored: 'hatch_sess=prior-session', rows: [cookie()], setSecret: (_key, _value, count) => count === 1 ? writing.promise : undefined });
  await f.helper.login('start'); const tick = f.helper.tick(); await until(() => f.writes.length === 1);
  await f.helper.login('cancel'); writing.resolve(); await tick;
  assert.equal(f.stored(), 'hatch_sess=prior-session');
  assert.equal((await f.helper.login('status')).state, 'pending');
  assert.equal(f.launches.length, 1);
});

test('credential cleanup failures return a safe failure instead of claiming logout success', async t => {
  const f = fixture(t, { stored: 'hatch_sess=private-cookie', setSecret: () => { throw new Error('private-cookie could not be removed'); } });
  const response = await f.helper.login('logout');
  assert.equal(response.state, 'failed');
  assert.equal(JSON.stringify(response).includes('private-cookie'), false);
  assert.equal(f.launches.length, 0);
});
