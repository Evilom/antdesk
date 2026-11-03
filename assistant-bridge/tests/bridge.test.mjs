import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createBridge } from '../server.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const agentIds = ['grokbot', 'gptdot'];
const callbackUrl = 'https://callbacks.example.test/dots';
const webhookUrl = 'https://hooks.example.test/grok';

async function eventually(read, accept, label, timeout = 4000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await sleep(10);
  }
  assert.fail(label + ' did not settle: ' + JSON.stringify(last));
}

/** The injected transport is the only outgoing path: these tests never contact a bot. */
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'antdesk-bridge-test-'));
  const storePath = join(directory, 'state.json');
  const adminToken = randomBytes(32).toString('base64url');
  const webhookKey = randomBytes(32).toString('base64url');
  const botTokens = agentIds.map(agentId => ({ agentId, token: randomBytes(32).toString('base64url') }));
  const signingKey = randomBytes(32);
  const signingSecret = 'whsec_' + signingKey.toString('base64');
  const outgoing = [];
  let bridge;
  let rpcId = 0;
  const controls = {
    challenge: undefined,
    event: async () => new Response(null, { status: 204 }),
    grok: async () => new Response(null, { status: 200 }),
  };
  function verifySigned(record) {
    const id = record.headers.get('webhook-id');
    const timestamp = record.headers.get('webhook-timestamp');
    assert.ok(id, 'webhook-id is present');
    assert.match(timestamp || '', /^\d+$/);
    assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30, 'signing time is current');
    const expected = createHmac('sha256', signingKey).update(id + '.' + timestamp + '.' + record.raw).digest();
    const signatures = (record.headers.get('webhook-signature') || '').split(/\s+/).filter(Boolean);
    assert.ok(signatures.some(signature => {
      const [version, encoded] = signature.split(',');
      if (version !== 'v1' || !encoded) return false;
      const actual = Buffer.from(encoded, 'base64');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    }), 'Standard Webhooks signature covers the exact transmitted bytes');
    assert.ok(record.headers.get('x-mcp-subscription-id'));
    if (record.body.type !== 'verification') assert.equal(id, record.body.eventId);
  }
  const webhookFetch = async (url, request = {}) => {
    const raw = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : String(request.body || '');
    const record = { url: String(url), headers: new Headers(request.headers), raw, body: JSON.parse(raw), at: Date.now() };
    outgoing.push(record);
    if (record.url === webhookUrl) {
      assert.equal(record.headers.get('authorization'), 'Bearer ' + webhookKey);
      return controls.grok(record);
    }
    assert.equal(record.url, callbackUrl, 'No unexpected outbound destination is allowed in a fixture');
    verifySigned(record);
    if (record.body.type === 'verification') {
      const challenge = controls.challenge === undefined ? record.body.challenge : controls.challenge;
      return new Response(JSON.stringify({ challenge }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return controls.event(record);
  };
  const factoryOptions = { storePath, adminToken, publicUrl: 'https://antdesk.example.test', botTokens, webhookFetch, retryDelaysMs: [10, 20], queueUrl: 'http://127.0.0.1:1', ...options };
  const boot = async () => {
    bridge = await createBridge(factoryOptions);
    await bridge.listen(0, '127.0.0.1');
    assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  };
  t.after(async () => {
    try { if (bridge) await bridge.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await boot();
  const tokenFor = agent => botTokens.find(item => item.agentId === agent)?.token;
  const request = async (path, { method = 'GET', token = adminToken, body, headers = {} } = {}) => {
    const response = await fetch(bridge.baseUrl + path, {
      method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); }
      catch { assert.fail('Expected a JSON bridge response: ' + text.slice(0, 180)); }
    }
    return { status: response.status, body: parsed, headers: response.headers, text };
  };
  const rpc = async (agent, method, params = {}) => {
    const response = await request('/mcp', { method: 'POST', token: tokenFor(agent), body: { jsonrpc: '2.0', id: ++rpcId, method, params }, headers: { accept: 'application/json, text/event-stream' } });
    assert.equal(response.status, 200, 'Authenticated MCP request returns a JSON-RPC response');
    return response.body;
  };
  const initialize = async agent => {
    const result = await rpc(agent, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'antdesk-isolated-test', version: '1.0.0' } });
    assert.ok(result.result, 'MCP initialization succeeds');
    return result.result;
  };
  const tool = async (agent, name, args = {}) => {
    const response = await rpc(agent, 'tools/call', { name, arguments: args });
    assert.ok(response.result, 'Tool call produces a tool result');
    return response.result;
  };
  const successfulTool = async (agent, name, args = {}) => {
    const result = await tool(agent, name, args);
    assert.equal(Boolean(result.isError), false, name + ' succeeds');
    return result;
  };
  const subscribe = (agent = 'gptdot', extra = {}) => rpc(agent, 'events/subscribe', {
    name: 'antdesk.task.assigned', arguments: { agent_id: agent },
    delivery: { mode: 'webhook', url: callbackUrl, secret: signingSecret }, ttlMs: 60_000, ...extra,
  });
  const run = (id, protocol = 'grok-webhook', extra = {}) => ({
    id, idempotencyKey: 'key-' + id, taskId: 'task-' + id, title: 'Isolated task ' + id,
    instruction: 'Return a test result; do not contact any real service.', agentId: protocol === 'dots-mcp' ? 'gptdot' : 'grokbot',
    protocol, context: 'Fixture data', ...(protocol === 'grok-webhook' ? { webhookUrl, webhookKey } : {}), ...extra,
  });
  const create = payload => request('/api/runs', { method: 'POST', body: payload });
  const get = async id => {
    const response = await request('/api/runs/' + encodeURIComponent(id));
    assert.equal(response.status, 200);
    return response.body;
  };
  const accepted = id => eventually(() => get(id), value => value.deliveryStatus === 'accepted', 'accepted delivery');
  const grokCalls = () => outgoing.filter(item => item.url === webhookUrl);
  const eventCalls = () => outgoing.filter(item => item.url === callbackUrl && item.body.type !== 'verification');
  const restart = async () => { await bridge.close(); bridge = undefined; await boot(); };
  for (const agent of agentIds) await initialize(agent);
  return { request, rpc, tool, successfulTool, initialize, subscribe, run, create, get, accepted, grokCalls, eventCalls, restart, outgoing, controls, storePath, adminToken, webhookKey, signingSecret, tokenFor, verifySigned, get bridge() { return bridge; } };
}

test('MCP discovery advertises events on legacy and MCP 2 transports', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const discovery = await f.rpc('gptdot', 'server/discover');
  assert.deepEqual(discovery.result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discovery.result.capabilities, { tools: {}, events: {} });
  const initialized = await f.initialize('gptdot');
  assert.deepEqual(initialized.capabilities.experimental, { events: {} });
  const catalog = await f.rpc('gptdot', 'events/list');
  assert.equal(catalog.result.events[0].inputSchema.properties.agent_id.const, 'gptdot');
  assert.equal(f.bridge.state.data.agents.gptdot.mcpActivity.method, 'events/list');
  assert.equal(f.bridge.state.data.agents.gptdot.mcpActivity.methodHeader, 'absent');
  const scoped = f.request('/mcp', { method: 'POST', token: f.tokenFor('gptdot'), body: { jsonrpc: '2.0', id: 1001, method: 'ping' }, headers: { 'mcp-method': 'ping', 'mcp-protocol-version': '2026-07-28' } });
  assert.equal((await scoped).status, 200);
  const activity = f.bridge.state.data.agents.gptdot.mcpActivity;
  assert.deepEqual({ method: activity.method, protocolVersion: activity.protocolVersion, methodHeader: activity.methodHeader },
    { method: 'ping', protocolVersion: '2026-07-28', methodHeader: 'match' });
  assert.equal(JSON.stringify(activity).includes(f.tokenFor('gptdot')), false);
});

test('desktop admin and bot MCP credentials cannot cross their authentication boundary', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (const token of ['', 'wrong-secret', f.tokenFor('grokbot')]) {
    const response = await f.request('/api/status?agentId=grokbot&protocol=grok-webhook', { token });
    assert.equal(response.status, 401);
    assert.ok(!response.text.includes(f.adminToken));
  }
  const forbidden = await f.request('/mcp', { method: 'POST', token: f.adminToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  assert.equal(forbidden.status, 401, 'An admin token is not a bot identity');
  const allowed = await f.request('/api/status?agentId=grokbot&protocol=grok-webhook');
  assert.equal(allowed.status, 200);
  assert.equal(f.outgoing.length, 0, 'Authentication and status checks send no bot work');
});

test('MCP tools and event filters are limited to the authenticated bot', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('scope-one');
  assert.equal((await f.create(payload)).status, 202);
  await f.accepted(payload.id);
  const own = await f.successfulTool('grokbot', 'get_task', { run_id: payload.id });
  assert.ok(!JSON.stringify(own).includes(f.webhookKey), 'A bot never receives the Grok dispatch key');
  const deniedRead = await f.tool('gptdot', 'get_task', { run_id: payload.id });
  assert.equal(deniedRead.isError, true);
  const deniedWrite = await f.tool('gptdot', 'report_progress', { run_id: payload.id, text: 'Wrong agent', idempotency_key: 'scope-progress' });
  assert.equal(deniedWrite.isError, true);
  assert.equal((await f.get(payload.id)).progress, '');
  const listing = await f.successfulTool('gptdot', 'list_tasks');
  assert.ok(!JSON.stringify(listing).includes(payload.id), 'Another bot cannot enumerate this run');
  const foreignSubscription = await f.subscribe('gptdot', { arguments: { agent_id: 'grokbot' } });
  assert.ok(foreignSubscription.error, 'A bot cannot subscribe to another identity');
});

test('DOTS without a verified subscription rejects dispatch without creating a run', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('no-subscription', 'dots-mcp');
  assert.equal((await f.create(payload)).status, 409);
  assert.equal((await f.request('/api/runs/' + payload.id)).status, 404);
  assert.equal(f.eventCalls().length, 0);
});

test('concurrent duplicate dispatch has one Grok side effect and conflicting content is rejected', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('dedupe');
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.create(payload)));
  assert.ok(responses.every(item => [200, 202].includes(item.status)));
  const run = await f.accepted(payload.id);
  assert.equal(run.id, payload.id);
  assert.equal(f.grokCalls().length, 1);
  const conflict = await f.create({ ...payload, instruction: 'Different requested work' });
  assert.equal(conflict.status, 409);
  assert.equal(f.grokCalls().length, 1);
  const disk = await readFile(f.storePath, 'utf8');
  assert.ok(!disk.includes(f.webhookKey), 'Webhook secrets never enter persistent task data');
});

test('a Grok 200 response records delivery but does not manufacture a result', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('accepted-only');
  assert.equal((await f.create(payload)).status, 202);
  const run = await f.accepted(payload.id);
  assert.equal(run.status, 'running');
  assert.equal(run.result, '');
  await sleep(30);
  assert.equal((await f.get(payload.id)).status, 'running');
});

test('MCP progress and final results are durable, idempotent, and terminal results cannot be overwritten', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('work-cycle');
  assert.equal((await f.create(payload)).status, 202);
  await f.accepted(payload.id);
  await f.successfulTool('grokbot', 'claim_task', { run_id: payload.id });
  const progress = { run_id: payload.id, text: 'Checking references', idempotency_key: 'progress-one' };
  await f.successfulTool('grokbot', 'report_progress', progress);
  const first = await f.get(payload.id);
  assert.equal(first.progress, progress.text);
  assert.equal(first.status, 'running');
  assert.equal(first.result, '');
  await f.successfulTool('grokbot', 'report_progress', progress);
  assert.equal((await f.get(payload.id)).updatedAt, first.updatedAt, 'A repeated progress receipt has no second mutation');
  assert.equal((await f.tool('grokbot', 'report_progress', { ...progress, text: 'Changed content with same key' })).isError, true);
  const result = { run_id: payload.id, text: 'Verified result awaiting user review', idempotency_key: 'result-one' };
  await f.successfulTool('grokbot', 'submit_result', result);
  const completed = await f.get(payload.id);
  assert.equal(completed.status, 'review');
  assert.equal(completed.result, result.text);
  await f.successfulTool('grokbot', 'submit_result', result);
  assert.equal((await f.get(payload.id)).updatedAt, completed.updatedAt);
  assert.equal((await f.tool('grokbot', 'report_progress', { ...progress, text: 'Late overwrite', idempotency_key: 'late-progress' })).isError, true);
  assert.equal((await f.get(payload.id)).result, result.text);
});

test('cancellation closes local tracking and refuses late bot results', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('cancelled-task');
  assert.equal((await f.create(payload)).status, 202);
  await f.accepted(payload.id);
  const response = await f.request('/api/runs/' + payload.id + '/cancel', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'cancelled');
  assert.equal(response.body.remoteStopped, false);
  const late = await f.tool('grokbot', 'submit_result', { run_id: payload.id, text: 'Too late', idempotency_key: 'late-result' });
  assert.equal(late.isError, true);
  const current = await f.get(payload.id);
  assert.equal(current.status, 'cancelled');
  assert.equal(current.result, '');
  assert.equal((await f.request('/api/runs/' + payload.id + '/cancel', { method: 'POST' })).body.remoteStopped, false);
});

test('assistants reorder the shared durable queue with revision and task validation', { timeout: 10_000 }, async t => {
  let revision = 3;
  const tasks = [{id:'local:a',title:'写方案',rank:1},{id:'local:b',title:'核对数据',rank:2}];
  const calls = [];
  const f = await fixture(t, {queueRequest: async (name, args) => {
    calls.push({name,args});
    if(name === 'list_priority_queue') return {revision,tasks};
    if(args.expected_revision !== revision) { const {BridgeError} = await import('../lib/util.mjs'); throw new BridgeError(409,'queue_conflict','QUEUE_CONFLICT: Read the current queue first.'); }
    revision++;
    return {revision,tasks:[...tasks].reverse().map((task,index)=>({...task,rank:index+1}))};
  }});
  const catalog = await f.rpc('grokbot', 'tools/list');
  assert.ok(catalog.result.tools.some(tool => tool.name === 'list_priority_queue'));
  assert.ok(catalog.result.tools.some(tool => tool.name === 'reorder_priority_queue'));
  const before = await f.successfulTool('grokbot', 'list_priority_queue');
  assert.equal(before.structuredContent.revision, 3);
  const after = await f.successfulTool('grokbot', 'reorder_priority_queue', {expected_revision:3,ordered_task_ids:['local:b','local:a']});
  assert.equal(after.structuredContent.revision, 4);
  assert.equal(after.structuredContent.tasks[0].id, 'local:b');
  const stale = await f.tool('grokbot', 'reorder_priority_queue', {expected_revision:3,ordered_task_ids:['local:a','local:b']});
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /QUEUE_CONFLICT/);
  assert.equal(revision, 4);
  assert.deepEqual(calls.map(call => call.name), ['list_priority_queue','reorder_priority_queue','reorder_priority_queue']);
});

test('queue forwarding authenticates the loopback desktop and preserves conflicts', async t => {
  const requests=[];
  const native=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    requests.push({token:req.headers['x-antdesk-queue-token'],type:req.headers['content-type'],body:JSON.parse(body)});
    res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({service:'antdesk-planner',version:1,error:{code:'queue_conflict',message:'QUEUE_CONFLICT: Read the current queue first.'}}));
  });});
  await new Promise(resolve=>native.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>native.close(resolve)));
  const f=await fixture(t,{queueUrl:'http://127.0.0.1:'+native.address().port});
  const result=await f.tool('grokbot','reorder_priority_queue',{expected_revision:3,ordered_task_ids:['local:a']});
  assert.equal(result.isError,true);assert.ok(result.content[0].text.includes('QUEUE_CONFLICT'));
  const expected=createHash('sha256').update('antdesk-queue-v1\0'+f.adminToken).digest('base64url');
  assert.equal(requests[0].token,expected);assert.equal(requests[0].type,'application/json');
});

test('planner discovery follows a changed loopback port and rejects nonlocal or corrupt endpoints', async t => {
  const requests=[];
  const native=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
    requests.push({token:req.headers['x-antdesk-queue-token'],body:JSON.parse(body)});
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({service:'antdesk-planner',version:1,revision:12,tasks:[{id:'local:a',title:'当前主线'}]}));
  });});
  await new Promise(resolve=>native.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>native.close(resolve)));
  const f=await fixture(t,{queueUrl:'http://127.0.0.1:1'});
  const discovery=join(dirname(f.storePath),'planner-endpoint.json');
  await writeFile(discovery,JSON.stringify({version:1,url:'http://127.0.0.1:'+native.address().port}));
  const value=await f.successfulTool('grokbot','list_priority_queue');
  assert.equal(JSON.parse(value.content[0].text).revision,12);assert.equal(requests.length,1);
  assert.equal(requests[0].token,createHash('sha256').update('antdesk-queue-v1\0'+f.adminToken).digest('base64url'));
  await writeFile(discovery,JSON.stringify({version:1,url:'https://example.invalid/'}));
  assert.equal((await f.tool('grokbot','list_priority_queue')).isError,true);assert.equal(requests.length,1);
  await writeFile(discovery,'invalid');
  assert.equal((await f.tool('grokbot','list_priority_queue')).isError,true);assert.equal(requests.length,1);
});

test('a loopback static-Bearer bridge returns no malformed OAuth resource metadata', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { publicUrl: '' });
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) {
    const response = await f.request(path, { token: undefined });
    assert.equal(response.status, 404);
    assert.equal(response.body.resource, undefined);
  }
  assert.ok((await f.initialize('gptdot')).capabilities.events);
});

test('DOTS callback verification and task delivery carry valid official event signatures', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const subscription = await f.subscribe();
  assert.ok(subscription.result?.id);
  assert.equal(f.outgoing.filter(item => item.body.type === 'verification').length, 1);
  const payload = f.run('signed-event', 'dots-mcp');
  assert.equal((await f.create(payload)).status, 202);
  const run = await f.accepted(payload.id);
  assert.equal(run.status, 'running');
  assert.equal(run.result, '');
  const events = f.eventCalls();
  assert.equal(events.length, 1);
  assert.equal(events[0].body.name, 'antdesk.task.assigned');
  assert.equal(events[0].body.data.run_id, payload.id);
  assert.equal(events[0].headers.get('x-mcp-subscription-id'), subscription.result.id);
  assert.equal(events[0].body.cursor, null);
  f.verifySigned(events[0]);
  const saved = await readFile(f.storePath, 'utf8');
  assert.ok(!saved.includes(f.signingSecret), 'Subscription signing secrets are protected at rest');
});

test('an invalid callback challenge cannot activate an event subscription', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  f.controls.challenge = 'not-the-challenge';
  const rejected = await f.subscribe();
  assert.equal(rejected.error?.code, -32015);
  assert.equal((await f.create(f.run('bad-challenge', 'dots-mcp'))).status, 409);
  assert.equal(f.eventCalls().length, 0);
});

test('transient DOTS delivery failures retry the same event rather than creating duplicate work', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  assert.ok((await f.subscribe()).result);
  let attempts = 0;
  f.controls.event = async () => new Response(null, { status: ++attempts < 3 ? 503 : 204 });
  const payload = f.run('retry-event', 'dots-mcp');
  assert.equal((await f.create(payload)).status, 202);
  const run = await f.accepted(payload.id);
  assert.equal(run.status, 'running');
  const events = f.eventCalls();
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map(item => item.body.eventId)).size, 1);
  assert.equal(new Set(events.map(item => item.raw)).size, 1, 'The stable event payload is reused across attempts');
  for (const event of events) f.verifySigned(event);
  assert.equal((await f.create(payload)).status, 200);
  await sleep(50);
  assert.equal(f.eventCalls().length, 3);
});

test('expired and explicitly removed subscriptions cannot receive new tasks', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  assert.ok((await f.subscribe('gptdot', { ttlMs: 30 })).result);
  await sleep(60);
  assert.equal((await f.create(f.run('expired-event', 'dots-mcp'))).status, 409);
  assert.equal(f.eventCalls().length, 0);
  assert.ok((await f.subscribe()).result);
  const removed = await f.rpc('gptdot', 'events/unsubscribe', { name: 'antdesk.task.assigned', arguments: { agent_id: 'gptdot' }, delivery: { mode: 'webhook', url: callbackUrl } });
  assert.ok(removed.result);
  assert.equal((await f.create(f.run('removed-event', 'dots-mcp'))).status, 409);
  assert.equal(f.eventCalls().length, 0);
});

test('HTTP 410 event delivery is not retried', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  assert.ok((await f.subscribe()).result);
  f.controls.event = async () => new Response(null, { status: 410 });
  const payload = f.run('gone-callback', 'dots-mcp');
  assert.equal((await f.create(payload)).status, 202);
  const run = await eventually(() => f.get(payload.id), value => value.deliveryStatus === 'rejected', 'permanent event rejection');
  assert.notEqual(run.status, 'review');
  assert.equal(run.result, '');
  await sleep(80);
  assert.equal(f.eventCalls().length, 1);
  const status = await f.request('/api/status?agentId=gptdot&protocol=dots-mcp');
  assert.equal(status.body.readiness, 'needs_subscription');
  assert.equal((await f.create(f.run('after-gone-callback', 'dots-mcp'))).status, 409);
});

test('a verified DOTS subscription survives restart and refreshes with the same identity', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const first = await f.subscribe();
  assert.ok(first.result?.id);
  assert.equal(f.outgoing.filter(item => item.body.type === 'verification').length, 1);
  await f.restart();
  await f.initialize('gptdot');
  const ready = await f.request('/api/status?agentId=gptdot&protocol=dots-mcp');
  assert.equal(ready.body.readiness, 'ready');
  assert.equal(ready.body.subscriptionCount, 1);
  const renewed = await f.subscribe();
  assert.equal(renewed.result.id, first.result.id);
  assert.equal(f.outgoing.filter(item => item.body.type === 'verification').length, 1, 'A recently verified same-key callback renews without another challenge');
  const different = await f.subscribe('gptdot', { delivery: { mode: 'webhook', url: callbackUrl + '/another-chat', secret: f.signingSecret } });
  assert.ok(different.error, 'A second chat cannot independently consume the same assistant queue');
  const payload = f.run('after-subscription-restart', 'dots-mcp');
  assert.equal((await f.create(payload)).status, 202);
  await f.accepted(payload.id);
  assert.equal(f.eventCalls().length, 1);
});

test('restart preserves accepted work and idempotency without sending Grok again', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const payload = f.run('persisted-run');
  assert.equal((await f.create(payload)).status, 202);
  await f.accepted(payload.id);
  await f.successfulTool('grokbot', 'report_progress', { run_id: payload.id, text: 'Saved before restart', idempotency_key: 'persisted-progress' });
  const before = await f.get(payload.id);
  await f.restart();
  const restored = await f.get(payload.id);
  assert.equal(restored.id, before.id);
  assert.equal(restored.progress, before.progress);
  assert.equal(restored.deliveryStatus, 'accepted');
  await f.initialize('grokbot');
  assert.equal((await f.create(payload)).status, 200);
  assert.equal(f.grokCalls().length, 1);
  await f.successfulTool('grokbot', 'submit_result', { run_id: payload.id, text: 'Finished after restart', idempotency_key: 'after-restart-result' });
  assert.equal((await f.get(payload.id)).status, 'review');
  assert.equal(f.grokCalls().length, 1);
});

test('an ambiguous Grok network failure stays unknown across restart and never automatically repeats dispatch', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  f.controls.grok = async () => { throw new Error('Simulated connection loss after sending bytes'); };
  const payload = f.run('unknown-delivery');
  assert.equal((await f.create(payload)).status, 202);
  const uncertain = await eventually(() => f.get(payload.id), value => value.deliveryStatus === 'unknown', 'unknown dispatch outcome');
  assert.notEqual(uncertain.status, 'review');
  assert.equal(uncertain.result, '');
  await f.restart();
  await f.initialize('grokbot');
  assert.equal((await f.create(payload)).status, 200);
  assert.equal((await f.get(payload.id)).deliveryStatus, 'unknown');
  await sleep(50);
  assert.equal(f.grokCalls().length, 1);
  // The original Bot may have received the task even though its HTTP response was lost.
  await f.successfulTool('grokbot', 'claim_task', { run_id: payload.id });
  await f.successfulTool('grokbot', 'report_progress', { run_id: payload.id, text: 'The original Bot is working', idempotency_key: 'unknown-confirmed' });
  const confirmed = await f.get(payload.id);
  assert.equal(confirmed.deliveryStatus, 'accepted');
  assert.equal(confirmed.status, 'running');
  await f.successfulTool('grokbot', 'submit_result', { run_id: payload.id, text: 'Original work recovered', idempotency_key: 'unknown-result' });
  assert.equal((await f.get(payload.id)).status, 'review');
  assert.equal(f.grokCalls().length, 1);
});

test('unknown delivery keeps its task occupied until the original execution is explicitly cancelled', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  f.controls.grok = async () => { throw new Error('The original dispatch may have been received'); };
  const original = f.run('unknown-task-lock');
  assert.equal((await f.create(original)).status, 202);
  await eventually(() => f.get(original.id), value => value.deliveryStatus === 'unknown', 'uncertain task lock');
  const replacement = f.run('unknown-task-replacement', 'grok-webhook', { taskId: original.taskId });
  assert.equal((await f.create(replacement)).status, 409, 'A new run must not duplicate uncertain work');
  assert.equal(f.grokCalls().length, 1);
  await f.restart();
  await f.initialize('grokbot');
  assert.equal((await f.create(replacement)).status, 409, 'The task lock survives a bridge restart');
  assert.equal(f.grokCalls().length, 1);
  const cancelled = await f.request('/api/runs/' + original.id + '/cancel', { method: 'POST' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.remoteStopped, false, 'Stopping local tracking makes no remote cancellation promise');
  f.controls.grok = async () => new Response(null, { status: 200 });
  assert.equal((await f.create(replacement)).status, 202);
  await f.accepted(replacement.id);
  assert.equal(f.grokCalls().length, 2, 'A second dispatch occurs only after explicit cancellation');
  const lateResult = await f.tool('grokbot', 'submit_result', { run_id: original.id, text: 'Too late', idempotency_key: 'cancelled-unknown-result' });
  assert.equal(lateResult.isError, true);
  assert.equal((await f.get(original.id)).status, 'cancelled');
});
