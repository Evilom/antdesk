import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDotsAdapter, createDotsClient } from '../runtime/dots.mjs';

const run = () => ({ id: 'run-1', taskId: 'task-1', agentId: 'dot-1', title: '安排今天事项', instruction: '按优先级整理', context: '', createdAt: Date.now(), runtimeData: {} });
const profile = { id: 'dot-1', display_name: 'omdot', scope: 'personal', status: 'active', aeon_kind: 'orbit', messaging_room_id: 'room-1', active_root_thread_id: 'original-thread', service_account_account_user_id: 'bot-member' };
const room = { id: 'room-1', type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'dot-1', members: [
  { account_user_id: 'person-member', name: 'User' }, { account_user_id: 'bot-member', aeon_id: 'dot-1', name: 'omdot' },
] };
const old = { id: 'old-message', account_user_id: 'bot-member', content: { text: '旧的结果' } };

function fixture(settings = {}) {
  const calls = []; let sentBody, polls = 0, posts = 0;
  const state = { auth: settings.loggedIn === false ? null : { token: 'fresh-fixture-token-secret', accountId: 'account-1', userId: 'user-1' } };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url); calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    assert.equal(parsed.origin, 'https://chatgpt.com');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, 'Bearer ' + state.auth.token);
    assert.equal(init.headers['ChatGPT-Account-ID'], state.auth.accountId);
    assert.equal(init.headers.originator, 'Codex Desktop');
    assert.equal(init.headers['OAI-Product-Sku'], 'CODEX');
    const p = parsed.pathname;
    if (p === '/backend-api/tbo') return Response.json({ items: settings.dots || [profile], cursor: null });
    if (p === '/backend-api/tbo/dot-1') return Response.json(settings.profile || profile);
    if (p === '/backend-api/messaging/rooms/room-1') return Response.json(settings.room || room);
    if (p === '/backend-api/messaging/rooms/room-1/messages') {
      if (init.method === 'POST') {
        posts++; sentBody = JSON.parse(init.body);
        assert.equal(sentBody.idempotency_token, sentBody.request_id);
        assert.match(sentBody.request_id, /^[a-f0-9-]{36}$/);
        assert.equal('app_attest_challenge' in sentBody, false);
        assert.equal(Object.keys(init.headers).some(h => /attest|sentinel|device.?check/i.test(h)), false);
        if (settings.post) return settings.post(sentBody);
        return Response.json({ id: 'our-anchor', request_id: sentBody.request_id, account_user_id: 'person-member', content: sentBody.content });
      }
      if (!sentBody) return Response.json({ items: [old], next_cursor: null, prev_cursor: null });
      polls++;
      const echo = { id: 'our-anchor', request_id: sentBody.request_id, account_user_id: 'person-member', content: sentBody.content };
      const answer = { id: 'our-result', account_user_id: 'bot-member', reply_to: { message_id: 'our-anchor' }, content: { text: '优先完成设计稿，然后整理账单。\n[[ANTDESK_DONE:' + sentBody.request_id + ']]' } };
      const items = settings.messages ? settings.messages({ echo, answer, polls, sentBody }) : [echo, answer];
      return Response.json({ items, next_cursor: null, prev_cursor: null });
    }
    throw new Error('Unexpected fixture path: ' + p);
  };
  const opts = { getAuth: async () => state.auth, fetchImpl, pollMs: 1, maxPollMs: 200, ...settings.options };
  return { opts, state, calls, get posts() { return posts; }, get polls() { return polls; }, get sentBody() { return sentBody; } };
}

test('Dots before fresh login makes no HTTP requests and never searches for existing credentials', async () => {
  const f = fixture({ loggedIn: false }), adapter = createDotsAdapter(f.opts);
  assert.equal((await adapter.status()).readiness, 'needs_login');
  assert.deepEqual(await adapter.login('status'), { state: 'idle' });
  assert.equal(f.calls.length, 0); await adapter.close();
});

test('Dots uses the official auth owner and destroys it without leaking its token fields', async () => {
  let closed = 0, loginCalls = 0, http = 0;
  const adapter = createDotsAdapter({ auth: {
    status: async () => ({ installed: false, readiness: 'needs_install', message: 'Install runtime', token: 'do-not-expose', idToken: 'do-not-expose-either' }),
    getAuth: async () => null, login: async action => { loginCalls++; return { state: action === 'start' ? 'pending' : 'idle', url: 'https://auth.openai.com/authorize' }; },
    close: async () => { closed++; },
  }, fetchImpl: async () => { http++; throw new Error('No network'); } });
  const state = await adapter.status(); assert.equal(state.readiness, 'needs_install'); assert.equal(state.installed, false);
  assert.ok(!JSON.stringify(state).includes('do-not-expose'));
  assert.equal((await adapter.login('start')).state, 'pending');
  assert.equal(loginCalls, 1); assert.equal(http, 0);
  await adapter.close(); assert.equal(closed, 1);
});

test('official auth failures retain only known public diagnostics across the Dots status boundary', async () => {
  let http = 0;
  for (const code of ['profile_not_isolated', 'protocol_mismatch']) {
    const adapter = createDotsAdapter({ authStatus: async () => ({
      installed: true, readiness: 'needs_login', message: '官方登录组件暂时不可用。',
      diagnostic: { stage: 'authorization', code, retryable: true, token: 'private-fixture-token', raw: { profile: 'private-profile-path' } },
    }), fetchImpl: async () => { http++; throw new Error('No network while authentication is blocked'); } });
    const state = await adapter.status();
    assert.deepEqual(state.diagnostic, { stage: 'runtime', code, retryable: false });
    assert.ok(!JSON.stringify(state).includes('private-fixture-token'));
    assert.ok(!JSON.stringify(state).includes('private-profile-path'));
    await adapter.close();
  }
  const adapter = createDotsAdapter({ authStatus: async () => ({
    readiness: 'needs_login', diagnostic: { stage: 'runtime', code: 'unknown-sensitive-detail', retryable: false },
  }) });
  const state = await adapter.status(); assert.equal(Object.hasOwn(state, 'diagnostic'), false);
  assert.ok(!JSON.stringify(state).includes('unknown-sensitive-detail'));
  assert.equal(http, 0); await adapter.close();
});

test('login probing lists the existing omdot and verifies its real room using only GET', async () => {
  const f = fixture(), adapter = createDotsAdapter(f.opts);
  const roster = await adapter.agents(); assert.equal(roster.agents[0].name, 'omdot'); assert.equal(roster.agents[0].id, 'dot-1');
  const sessions = await adapter.sessions({ agentId: 'dot-1' }); assert.equal(sessions.sessions[0].id, 'room-1');
  const state = await adapter.status({ agentId: 'dot-1' }); assert.equal(state.readiness, 'ready'); assert.equal(state.sessionId, 'room-1');
  assert.ok(f.calls.every(c => c.method === 'GET')); assert.equal(f.posts, 0);
  assert.ok(!JSON.stringify([roster, sessions, state]).includes('fixture-token-secret'));
  await adapter.close();
});

test('a room for another Dot and an unverified bot member cannot receive the task', async () => {
  for (const changed of [{ ...room, aeon_id: 'different-dot' }, { ...room, members: [{ account_user_id: 'different-bot', aeon_id: 'different-dot' }] }]) {
    const f = fixture({ room: changed }), adapter = createDotsAdapter(f.opts), events = [];
    await adapter.start(run(), e => events.push(e));
    assert.equal(f.posts, 0); assert.equal(events.at(-1).type, 'failed'); assert.equal(events.at(-1).deliveryStatus, 'rejected');
    await adapter.close();
  }
});

test('missing original room never causes creation of a new Dot or Codex thread', async () => {
  const f = fixture({ profile: { ...profile, messaging_room_id: null } }), adapter = createDotsAdapter(f.opts);
  assert.equal((await adapter.status({ agentId: 'dot-1' })).readiness, 'needs_agent_connection');
  await assert.rejects(adapter.sessions({ agentId: 'dot-1' }), { code: 'needs_room' });
  assert.ok(f.calls.every(c => c.method === 'GET')); await adapter.close();
});

test('dispatch does not download the original room transcript', async () => {
  const f = fixture(), adapter = createDotsAdapter(f.opts);
  await adapter.status({ agentId: 'dot-1' });
  await adapter.sessions({ agentId: 'dot-1' });
  assert.equal(f.calls.some(call => call.url.includes('/messages')), false);
  await adapter.start(run(), () => {});
  const postAt = f.calls.findIndex(call => call.method === 'POST');
  assert.ok(postAt > 0);
  assert.equal(f.calls.slice(0, postAt).some(call => call.url.includes('/messages')), false);
  const reads = f.calls.slice(postAt + 1).filter(call => call.method === 'GET' && call.url.includes('/messages'));
  assert.ok(reads.length >= 1);
  for (const call of reads) {
    const query = new URL(call.url).searchParams;
    assert.equal(query.get('after'), 'our-anchor');
    const limit = Number(query.get('limit'));
    assert.ok(limit >= 1 && limit <= 20);
  }
  await adapter.close();
});

test('dispatch persists its request identity, uses the original room, and removes the final marker from UI results', async () => {
  const f = fixture(), adapter = createDotsAdapter(f.opts), events = [], value = run();
  await adapter.start(value, e => events.push(e));
  assert.equal(f.posts, 1); assert.equal(events[0].type, 'checkpoint');
  assert.equal(events[0].sessionId, 'room-1'); assert.ok(events[0].data.accountKey);
  assert.equal(events.at(-1).type, 'complete'); assert.equal(events.at(-1).turnId, 'our-anchor');
  assert.equal(events.at(-1).text, '优先完成设计稿，然后整理账单。');
  assert.ok(!JSON.stringify(events.filter(e => e.type === 'message')).includes('ANTDESK_DONE'));
  assert.ok(!JSON.stringify(events).includes('fixture-token-secret'));
  assert.equal(value.runtimeData.requestId, f.sentBody.request_id); await adapter.close();
});

test('an uncertain send is discovered by the same request ID without any replay', async () => {
  const f = fixture({ post: () => { throw new Error('network loss with private information'); } }), adapter = createDotsAdapter(f.opts), events = [];
  await adapter.start(run(), e => events.push(e));
  assert.equal(f.posts, 1); assert.ok(events.some(e => e.type === 'interrupted' && e.deliveryStatus === 'unknown'));
  assert.ok(events.some(e => e.type === 'started' && e.turnId === 'our-anchor'));
  assert.equal(events.at(-1).type, 'complete');
  assert.ok(!JSON.stringify(events).includes('private information')); await adapter.close();
});

test('ordinary progress, another sender, and another task marker do not complete this task', async () => {
  const f = fixture({ messages: ({ echo, answer }) => [echo,
    { ...answer, id: 'progress', content: { text: '正在分析优先级' } },
    { ...answer, id: 'spoofed-person', account_user_id: 'person-member' },
    { ...answer, id: 'other-dot', account_user_id: 'unrelated-bot' },
    { ...answer, id: 'other-task', content: { text: 'Other task complete\n[[ANTDESK_DONE:00000000-0000-4000-8000-000000000000]]' } },
  ] }), adapter = createDotsAdapter(f.opts), events = [];
  await adapter.start(run(), e => events.push(e));
  assert.equal(f.posts, 1); assert.equal(events.some(e => e.type === 'complete'), false);
  assert.equal(events.at(-1).type, 'interrupted');
  assert.equal(events.some(e => e.type === 'message' && ['spoofed-person', 'other-dot'].includes(e.id)), false);
  await adapter.close();
});

test('a marker still being generated is not a completed result', async () => {
  const f = fixture({ messages: ({ echo, answer, polls }) => [echo, { ...answer, generation: { status: polls < 2 ? 'in_progress' : 'complete' } }] });
  const adapter = createDotsAdapter(f.opts), events = [];
  await adapter.start(run(), e => events.push({ ...e, atPoll: f.polls }));
  assert.equal(events.find(e => e.type === 'complete').atPoll, 2); await adapter.close();
});

test('device verification is reported as blocked and no verification proof is fabricated', async () => {
  const f = fixture({ post: () => Response.json({ detail: { code: 'integrity_missing', message: 'private upstream detail' } }, { status: 403 }) });
  const adapter = createDotsAdapter(f.opts), events = [];
  await adapter.start(run(), e => events.push(e));
  assert.equal(f.posts, 1); assert.equal(events.at(-1).type, 'failed'); assert.equal(events.at(-1).deliveryStatus, 'rejected');
  const state = await adapter.status({ agentId: 'dot-1' }); assert.equal(state.readiness, 'blocked'); assert.equal(state.reason, 'device_verification_required');
  assert.ok(!JSON.stringify([events, state]).includes('private upstream detail'));
  await adapter.close();
});

test('web challenges, client proofs and account access denials retain distinct public reasons', async () => {
  const cases = [
    { headers: { 'cf-mitigated': 'challenge' }, body: { detail: 'opaque response' }, reason: 'browser_verification_required' },
    { body: { detail: { code: 'cloudflare_challenge', message: 'private upstream data' } }, reason: 'browser_verification_required' },
    { body: { detail: { code: 'captcha_required' } }, reason: 'browser_verification_required' },
    { body: { detail: { code: 'challenge_required' } }, reason: 'browser_verification_required' },
    { body: { detail: { code: 'integrity_missing' } }, reason: 'device_verification_required' },
    { body: { detail: { code: 'app_attest_challenge_required' } }, reason: 'device_verification_required' },
    { body: { detail: { code: 'sentinel_required' } }, reason: 'device_verification_required' },
    { body: { detail: { code: 'access_denied' } }, reason: 'dots_access_denied' },
  ];
  for (const item of cases) {
    const f = fixture(); let requests = 0;
    const adapter = createDotsAdapter({ ...f.opts, fetchImpl: async (_url, init) => {
      requests++; assert.equal(init.method, 'GET');
      return Response.json(item.body, { status: 403, headers: item.headers });
    } });
    const state = await adapter.status();
    assert.equal(state.readiness, 'blocked'); assert.equal(state.reason, item.reason);
    assert.match(state.connectionIdentity, /^[a-f0-9]{64}$/);
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(state).includes('private upstream data'));
    assert.ok(!JSON.stringify(state).includes('fixture-token-secret'));
    await adapter.close();
  }
});

test('a blocked status permits explicit read-only recheck and expires without requiring a new login', async () => {
  const f = fixture(); let clock = 1000, reject = true, requests = 0;
  const adapter = createDotsAdapter({ ...f.opts, now: () => clock, blockedCacheTtlMs: 100,
    fetchImpl: async (url, init) => {
      requests++; assert.equal(init.method, 'GET');
      return reject ? Response.json({ detail: { code: 'cloudflare_challenge' } }, { status: 403 }) : f.opts.fetchImpl(url, init);
    },
  });
  assert.equal((await adapter.status()).readiness, 'blocked'); assert.equal(requests, 1);
  reject = false;
  assert.equal((await adapter.status()).readiness, 'blocked'); assert.equal(requests, 1);
  assert.equal((await adapter.status({ refresh: true })).readiness, 'ready'); assert.equal(requests, 2);
  reject = true;
  assert.equal((await adapter.status({ refresh: true })).readiness, 'blocked'); assert.equal(requests, 3);
  reject = false; clock += 101;
  assert.equal((await adapter.status()).readiness, 'ready'); assert.equal(requests, 4);
  assert.equal(f.posts, 0); await adapter.close();
});

test('connection identity is stable across token renewal and changes with either workspace or user', async () => {
  const f = fixture(), adapter = createDotsAdapter(f.opts);
  const hash = (account, user) => createHash('sha256').update(JSON.stringify([account, user])).digest('hex');
  const first = await adapter.status();
  assert.equal(first.connectionIdentity, hash('account-1', 'user-1'));
  f.state.auth.token = 'rotated-token-secret';
  assert.equal((await adapter.status()).connectionIdentity, first.connectionIdentity);
  f.state.auth.userId = 'user-2';
  assert.equal((await adapter.status()).connectionIdentity, hash('account-1', 'user-2'));
  f.state.auth.accountId = 'account-2';
  assert.equal((await adapter.status()).connectionIdentity, hash('account-2', 'user-2'));
  f.state.auth = null;
  const signedOut = await adapter.status();
  assert.equal(signedOut.readiness, 'needs_login');
  assert.equal(Object.hasOwn(signedOut, 'connectionIdentity'), false);
  await adapter.close();
});

test('an unready auth owner cannot publish a stale connection identity or any account fields', async () => {
  const adapter = createDotsAdapter({ authStatus: async () => ({ readiness: 'needs_login', installed: true,
    connectionIdentity: 'stale-private-identity', token: 'private-token', accountId: 'private-account', userId: 'private-user' }),
    getAuth: async () => { assert.fail('An unready auth owner must not release identity'); },
  });
  const state = await adapter.status();
  assert.equal(Object.hasOwn(state, 'connectionIdentity'), false);
  assert.ok(!JSON.stringify(state).includes('private'));
  await adapter.close();
});

test('a resource 401 and an account switch in flight cannot return the previous connection identity', async () => {
  for (const mode of ['unauthorized', 'switch', 'logout']) {
    const f = fixture(); let calls = 0;
    const adapter = createDotsAdapter({ ...f.opts, fetchImpl: async () => {
      calls++;
      if (mode === 'switch') f.state.auth = { token: 'second-token', accountId: 'account-1', userId: 'other-user' };
      if (mode === 'logout') f.state.auth = null;
      return Response.json({ detail: { code: mode === 'unauthorized' ? 'expired' : 'integrity_missing' } }, { status: mode === 'unauthorized' ? 401 : 403 });
    } });
    const state = await adapter.status();
    assert.equal(Object.hasOwn(state, 'connectionIdentity'), false, mode);
    assert.ok(calls <= 2); await adapter.close();
  }
});

test('a workspace without a stable user principal never creates an identity or reaches Dots', async () => {
  const f = fixture(); delete f.state.auth.userId;
  const adapter = createDotsAdapter(f.opts), state = await adapter.status();
  assert.equal(state.reason, 'account_identity_missing');
  assert.equal(Object.hasOwn(state, 'connectionIdentity'), false);
  assert.equal(f.calls.length, 0); await adapter.close();
});

test('recovery is read-only and a changed account never gets the original task', async () => {
  const f = fixture({ messages: ({ echo }) => [echo], options: { maxPollMs: 5 } }), adapter = createDotsAdapter(f.opts), value = run();
  await adapter.start(value, () => {}); assert.equal(f.posts, 1);
  const readStart = f.calls.length, events = [];
  await adapter.recover(value, e => events.push(e));
  assert.ok(f.calls.slice(readStart).every(c => c.method === 'GET')); assert.equal(f.posts, 1);
  const beforeSwitch = f.calls.length;
  f.state.auth = { token: 'new-account-token', accountId: 'another-account', userId: 'another-user' };
  await adapter.recover(value, e => events.push(e));
  assert.equal(f.calls.length, beforeSwitch); assert.equal(f.posts, 1); assert.equal(events.at(-1).type, 'interrupted');
  await adapter.close();
});

test('recovery without its persisted send checkpoint does not issue a new prompt', async () => {
  const f = fixture(), adapter = createDotsAdapter(f.opts), events = [];
  await adapter.recover(run(), e => events.push(e));
  assert.equal(f.posts, 0); assert.equal(f.calls.length, 0); assert.equal(events.at(-1).type, 'interrupted'); await adapter.close();
});

test('a 401 read refreshes once, remains bound to its original account, and refuses redirects', async () => {
  let fetches = 0, refreshes = 0;
  const client = createDotsClient({ getAuth: async ({ refreshToken }) => {
    if (refreshToken) refreshes++;
    return { token: 'fixture', accountId: refreshToken ? 'different-account' : 'account-1', userId: 'user-1' };
  }, fetchImpl: async (url, init) => {
    fetches++; assert.equal(init.redirect, 'error'); return Response.json({ detail: { code: 'expired' } }, { status: 401 });
  } });
  await assert.rejects(client.request('/tbo'), { code: 'account_changed' });
  assert.equal(fetches, 1); assert.equal(refreshes, 1);
  await assert.rejects(client.request('https://example.com/steal'), { code: 'invalid_endpoint' });
  await assert.rejects(client.request('/../../steal'), { code: 'invalid_endpoint' });
  assert.equal(fetches, 1);
});

test('a Dot id may contain a tilde and still opens its original room', async () => {
  const paths = [];
  const adapter = createDotsAdapter({
    getAuth: async () => ({ token: 'fixture-token', accountId: 'account-1', userId: 'user-1' }),
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith('/tbo/dot~one')) return Response.json({ id: 'dot~one', status: 'active', messaging_room_id: 'room-1', display_name: 'omdot' });
      if (url.includes('/messages')) return Response.json({ items: [], next_cursor: null });
      return Response.json({ id: 'room-1', type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'dot~one', members: [{ account_user_id: 'bot-member', aeon_id: 'dot~one' }] });
    },
  });
  const sessions = await adapter.sessions({ agentId: 'dot~one' });
  assert.equal(sessions.sessions[0].id, 'room-1');
  assert.ok(paths.includes('/backend-api/tbo/dot~one'));
  assert.equal(paths.some(path => path.includes('/messages')), false);
  await adapter.close();
});

test('one Dot cannot receive two concurrently dispatched AntDesk tasks', async () => {
  const f = fixture({ messages: ({ echo }) => [echo], options: { maxPollMs: 100 } }), adapter = createDotsAdapter(f.opts), first = run(), second = { ...run(), id: 'run-2' }, events = [];
  const running = adapter.start(first, () => {});
  while (!f.posts) await delay(1);
  await adapter.start(second, e => events.push(e)); assert.equal(f.posts, 1); assert.equal(events.at(-1).type, 'failed');
  const outcome = await adapter.cancel(first); assert.deepEqual(outcome, { remoteStopped: false });
  await running; await adapter.close();
});
