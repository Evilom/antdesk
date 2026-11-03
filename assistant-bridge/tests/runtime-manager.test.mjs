import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { RuntimeManager } from '../runtime/manager.mjs';
import { createBridge } from '../server.mjs';

const token='runtime-test-desktop-token-with-enough-entropy';
const wait = () => new Promise(resolve=>setTimeout(resolve,15));
const input = (extra={}) => ({id:'run-1',idempotencyKey:'key-1',taskId:'task-1',title:'Arrange priorities',instruction:'Review this task',agentId:'bot-1',protocol:'grok-direct',...extra});
function fixture(adapter, protocol='grok-direct') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-runtime-'));
  const store=new Store(path.join(dir,'state.json'),token);
  const runtimes=new RuntimeManager({store,projectRoot:dir,adapters:{[protocol]:adapter}});
  return {dir,store,runtimes,async close(){await runtimes.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
const ready = {status:async()=>({readiness:'ready',installed:true,official:false,message:'ready'})};

test('provider discovery exposes the three original assistants and Notion without initializing unused runtimes', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-runtime-discovery-'));
  const store=new Store(path.join(dir,'state.json'),token);
  const visible=['muse-personal','grok-direct','dots-direct','notion-web'];
  const dormant=['muse-code','deepseek-harness'];
  const statusCalls=[];
  const adapters=Object.fromEntries([...visible,...dormant].map(id=>[id,{
    status:async()=>{statusCalls.push(id);assert.ok(!dormant.includes(id),'Unused runtime status must stay dormant');return {readiness:'needs_login',installed:true,message:'fixture'};},
  }]));
  const runtimes=new RuntimeManager({store,projectRoot:dir,adapters});
  try {
    assert.deepEqual((await runtimes.providers()).providers.map(provider=>provider.id),visible);
    assert.deepEqual(statusCalls,visible);
    for (const protocol of dormant) {
      assert.equal(runtimes.adapters.has(protocol),false,'Discovery must not initialize '+protocol);
      assert.equal(runtimes.owns(protocol),true,'Saved '+protocol+' runs must retain runtime ownership');
    }
  } finally {await runtimes.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('runtime dispatch is durable, idempotent and exposes transcript snapshots', async()=>{
  let sends=0;
  const f=fixture({...ready,start:async(run,emit)=>{sends++;emit({type:'started',sessionId:'session-1',turnId:'turn-1'});emit({type:'message',id:'reply-1',role:'assistant',text:'Plan'});emit({type:'message',id:'reply-1',role:'assistant',text:'Plan ready'});emit({type:'complete',text:'Plan ready'});}});
  try {
    await Promise.all([f.runtimes.create(input()),f.runtimes.create(input())]);await wait();
    assert.equal(sends,1);const result=f.runtimes.get('run-1');assert.equal(result.status,'review');assert.equal(result.result,'Plan ready');assert.equal(result.sessionId,'session-1');assert.equal(result.messages.length,1);assert.equal(result.messages[0].text,'Plan ready');
    assert.equal((await f.runtimes.create(input())).created,false);
    await assert.rejects(f.runtimes.create(input({instruction:'Changed'})),e=>e.code==='idempotency_conflict');
  }finally{await f.close();}
});

test('Notion persists the selected model before dispatch and treats a changed model as a different request', async () => {
  const prepared = [], sent = [], persistedAtSend = [];
  const f = fixture({
    ...ready,
    prepare: async request => {
      prepared.push(structuredClone(request));
      return { accountId: 'account-original', workspaceId: 'workspace-original', model: request.model, threadId: 'thread-original' };
    },
    start: async (run, emit) => {
      sent.push(structuredClone(run));
      persistedAtSend.push(JSON.parse(fs.readFileSync(f.store.file, 'utf8')).runs[run.id]);
      emit({ type: 'started', sessionId: run.runtimeData.threadId });
      emit({ type: 'complete', text: 'Review from the selected model' });
    },
  }, 'notion-web');
  const request = input({ protocol: 'notion-web', agentId: 'notion-web', model: 'account-selected/model-v3' });
  try {
    const concurrent = await Promise.all([f.runtimes.create(request), f.runtimes.create(request)]);
    await wait();
    assert.equal(concurrent.filter(result => result.created).length, 1);
    assert.equal(sent.length, 1, 'An identical double submission must not create two Notion threads');
    assert.ok(prepared.length > 0);
    for (const value of [...prepared, ...sent, ...persistedAtSend]) assert.equal(value.model, request.model);
    assert.equal(persistedAtSend[0].status, 'queued', 'The request must be on disk before the adapter sends it');
    assert.equal(persistedAtSend[0].runtimeData.model, request.model);
    assert.equal(persistedAtSend[0].runtimeData.workspaceId, 'workspace-original');
    assert.equal((await f.runtimes.create(request)).created, false);
    await assert.rejects(f.runtimes.create({ ...request, model: '' }), error => error.code === 'idempotency_conflict');
    await assert.rejects(f.runtimes.create({ ...request, model: 'another-account-model' }), error => error.code === 'idempotency_conflict');
    assert.equal(sent.length, 1);
    assert.equal(f.runtimes.get(request.id).status, 'review');
  } finally { await f.close(); }
});

test('Notion leaves an omitted model unpinned and carries explicit Auto through without selecting a catalog model', async () => {
  const sent = [];
  const f = fixture({ ...ready, start: async (run, emit) => { sent.push(run.model); emit({ type: 'complete', text: 'Review' }); } }, 'notion-web');
  try {
    const models = [undefined, '', 'auto'];
    for (const [index, model] of models.entries()) {
      await f.runtimes.create(input({ protocol: 'notion-web', agentId: 'notion-web', model,
        id: 'auto-run-' + index, taskId: 'auto-task-' + index, idempotencyKey: 'auto-key-' + index }));
    }
    await wait();
    assert.deepEqual(sent, ['', '', 'auto']);
    assert.deepEqual(models.map((_, index) => f.store.data.runs['auto-run-' + index].model), ['', '', 'auto']);
  } finally { await f.close(); }
});

test('Notion restart recovers the original model and workspace without a second dispatch', async () => {
  let sends = 0, recovered;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({
    ...ready,
    prepare: async request => ({ accountId: 'account-original', workspaceId: 'workspace-original', model: request.model, threadId: 'thread-original' }),
    start: async (run, emit) => {
      sends++;
      emit({ type: 'checkpoint', data: { sendIntent: true } });
      emit({ type: 'started', sessionId: run.runtimeData.threadId });
      await pending;
    },
    close: async () => release(),
  }, 'notion-web');
  const request = input({ protocol: 'notion-web', agentId: 'notion-web', model: 'account-selected-model' });
  let restartedStore, restarted;
  try {
    await f.runtimes.create(request); await wait();
    await f.runtimes.close(); f.store.close();
    restartedStore = new Store(path.join(f.dir, 'state.json'), token);
    restarted = new RuntimeManager({ store: restartedStore, projectRoot: f.dir, adapters: { 'notion-web': {
      ...ready,
      start: async () => { sends++; },
      recover: async (run, emit) => {
        recovered = structuredClone(run);
        emit({ type: 'complete', text: 'Recovered original Notion reply' });
      },
    } } });
    assert.equal(restarted.get(request.id).status, 'interrupted');
    await wait();
    assert.equal(sends, 1);
    assert.ok(recovered, 'Restart must read the original request');
    assert.equal(recovered.model, request.model);
    assert.equal(recovered.runtimeData.model, request.model);
    assert.equal(recovered.runtimeData.accountId, 'account-original');
    assert.equal(recovered.runtimeData.workspaceId, 'workspace-original');
    assert.equal(recovered.runtimeData.threadId, 'thread-original');
    assert.equal(recovered.runtimeData.sendIntent, true);
    assert.equal(restarted.get(request.id).result, 'Recovered original Notion reply');
    assert.equal((await restarted.create(request)).created, false);
    await assert.rejects(restarted.create({ ...request, model: 'auto' }), error => error.code === 'idempotency_conflict');
    assert.equal(sends, 1);
  } finally {
    if (restarted) await restarted.close();
    restartedStore?.close();
    await f.close();
  }
});

test('restart queries original runtime without resending accepted work',async()=>{
  let sends=0,recovered=0,resolve;const pending=new Promise(r=>resolve=r);
  const f=fixture({...ready,start:async(r,emit)=>{sends++;emit({type:'started',sessionId:'existing-session'});await pending;},close:async()=>resolve()});
  await f.runtimes.create(input());await wait();await f.runtimes.close();f.store.close();
  const store=new Store(path.join(f.dir,'state.json'),token);
  const runtime=new RuntimeManager({store,projectRoot:f.dir,adapters:{'grok-direct':{...ready,start:async()=>sends++,recover:async(r,emit)=>{recovered++;assert.equal(r.sessionId,'existing-session');emit({type:'complete',text:'Recovered result'});}}}});
  try {assert.equal(runtime.get('run-1').status,'interrupted');await wait();assert.equal(runtime.get('run-1').result,'Recovered result');assert.equal(sends,1);assert.equal(recovered,1);}
  finally{await runtime.close();store.close();fs.rmSync(f.dir,{recursive:true,force:true});}
});

test('secrets are encrypted and never included in runtime snapshots',async()=>{
  const f=fixture(ready);
  try {const scoped=f.runtimes.options('grok-direct');scoped.setSecret('credentials','private-token-fixture');assert.equal(scoped.getSecret('credentials'),'private-token-fixture');assert.ok(!fs.readFileSync(f.store.file,'utf8').includes('private-token-fixture'));scoped.setSecret('credentials','');assert.equal(scoped.getSecret('credentials'),undefined);}
  finally{await f.close();}
});

test('stale or duplicate human approvals cannot reach the runtime',async()=>{
  let approvals=0;const f=fixture({...ready,start:async(r,emit)=>{emit({type:'started'});emit({type:'attention',attention:{id:'approval-1',kind:'approval',title:'Allow read?'}});},respond:async()=>{approvals++;return {ok:true};}});
  try {await f.runtimes.create(input());await wait();await assert.rejects(f.runtimes.respond('run-1',{attentionId:'old'}),e=>e.code==='attention_stale');const concurrent=await Promise.allSettled([f.runtimes.respond('run-1',{attentionId:'approval-1',decision:'deny'}),f.runtimes.respond('run-1',{attentionId:'approval-1',decision:'deny'})]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);await assert.rejects(f.runtimes.respond('run-1',{attentionId:'approval-1'}),e=>e.code==='attention_stale');assert.equal(approvals,1);}
  finally{await f.close();}
});

test('one original Bot cannot mix two concurrent AntDesk tasks',async()=>{
  let finish;const f=fixture({...ready,start:async()=>new Promise(r=>finish=r),cancel:async()=>{finish();return {remoteStopped:false};},close:async()=>finish?.()});
  try {await f.runtimes.create(input());await wait();await assert.rejects(f.runtimes.create(input({id:'run-2',idempotencyKey:'key-2',taskId:'task-2'})),e=>e.code==='agent_busy');const canceled=await f.runtimes.cancel('run-1');assert.equal(canceled.remoteStopped,false);assert.equal(canceled.status,'cancelled');}
  finally{await f.close();}
});

test('runtime HTTP management requires desktop auth and fixed route methods',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-runtime-http-'));let starts=0;
  const adapter={...ready,login:async action=>{if(action==='start')starts++;return {state:'idle',message:'fixture'};},agents:async()=>({agents:[{id:'bot-1',name:'Fixture'}]})};
  const bridge=await createBridge({storePath:path.join(dir,'state.json'),adminToken:token,projectRoot:dir,runtimeAdapters:Object.fromEntries(['grok-direct','muse-personal','muse-code','deepseek-harness','dots-direct','notion-web'].map(id=>[id,adapter]))});
  try {const base=await bridge.listen();const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/runtime/providers')).status,401);
    const providers=await (await fetch(base+'/api/runtime/providers',{headers})).json();assert.deepEqual(providers.providers.map(provider=>provider.id),['muse-personal','grok-direct','dots-direct','notion-web']);
    assert.equal((await fetch(base+'/api/runtime/providers/grok-direct/login/start',{headers})).status,405);
    assert.equal((await fetch(base+'/api/runtime/providers/grok-direct/login/start',{method:'POST',headers,body:'{}'})).status,200);assert.equal(starts,1);
    assert.equal((await fetch(base+'/api/runtime/providers/arbitrary/agents',{headers})).status,400);
    assert.equal((await fetch(base+'/api/runtime/providers',{headers:{...headers,Origin:'https://malicious.example'}})).status,403);
  }finally{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('reply acknowledgement preserves the next attention emitted during the response',async()=>{
  let send;
  const f=fixture({...ready,start:async(r,emit)=>{send=emit;emit({type:'started'});emit({type:'attention',attention:{id:'approval-1',kind:'approval',title:'First permission'}});},respond:async()=>{send({type:'attention',attention:{id:'input-2',kind:'input',title:'A new question'}});return {ok:true};}});
  try {await f.runtimes.create(input());await wait();const result=await f.runtimes.respond('run-1',{attentionId:'approval-1',decision:'allow'});assert.equal(result.run.attention.id,'input-2');assert.equal(f.store.data.runs['run-1'].attentionResponse,undefined);}
  finally{await f.close();}
});


test('original Dots readiness checks the selected identity and serializes its tasks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-dots-manager-'));
  const store = new Store(path.join(dir, 'state.json'), token);
  const seen = [];
  let release;
  const runtime = new RuntimeManager({store, projectRoot:dir, adapters:{'dots-direct':{
    status:async query => { seen.push(query?.agentId); return {readiness:query?.agentId === 'dot-original' ? 'ready' : 'blocked', message:'identity checked'}; },
    start:async (run, emit) => { emit({type:'started', sessionId:'original-room'}); await new Promise(resolve => release=resolve); },
    cancel:async()=>{release?.();return {remoteStopped:false};}, close:async()=>release?.(),
  }}});
  try {
    await assert.rejects(runtime.create(input({protocol:'dots-direct',agentId:'wrong-dot'})),error=>error.code==='blocked');
    await runtime.create(input({protocol:'dots-direct',agentId:'dot-original'})); await wait();
    await assert.rejects(runtime.create(input({protocol:'dots-direct',agentId:'dot-original',id:'run-2',taskId:'task-2',idempotencyKey:'key-2'})),error=>error.code==='agent_busy');
    assert.ok(seen.includes('dot-original'));
    assert.equal(runtime.get('run-1').sessionId, 'original-room');
    assert.equal((await runtime.cancel('run-1')).remoteStopped,false);
  } finally {await runtime.close();store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
