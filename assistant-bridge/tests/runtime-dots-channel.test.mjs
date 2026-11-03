import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {Events} from '../lib/events.mjs';
import {Jobs} from '../lib/jobs.mjs';
import {RuntimeManager} from '../runtime/manager.mjs';
import {createDotsChannel,DOT_EVENTS_AGENT} from '../runtime/dots-channel.mjs';
import {createBridge} from '../server.mjs';

const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('timed out');};
function fixture(t,mode='events') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-dot-channel-'));
  const store=new Store(path.join(dir,'state.json'),'test-admin-token-at-least-24-characters');
  let config={transport:mode,tunnelId:'tunnel_fixture',tunnelEnabled:true};
  store.commit(s=>{s.runtime={providers:{'dots-direct':{config:{...config},secrets:{}}}};});
  let health={installed:true,configured:true,state:'ready',version:'0.0.19',tunnelId:config.tunnelId,startedAt:Date.now()-1000};
  store.commit(s=>{s.agents[DOT_EVENTS_AGENT]={lastSeenAt:Date.now(),principalId:'bot:fixture'};});
  let starts=0,posts=0,directStarts=0;
  const tunnel={status:async()=>({...health}),start:async()=>{starts++;health.state='ready';return health;},stop:async()=>{health.state='idle';},close:async()=>{},configure:async value=>{config.tunnelId=value.tunnelId;health.state='idle';}};
  const direct={status:async()=>({readiness:'ready',installed:true,connectionIdentity:'direct-account'}),agents:async()=>({agents:[{id:'original-dot'}]}),sessions:async()=>({sessions:[]}),start:async(run,emit)=>{directStarts++;emit({type:'complete',text:'direct fixture'});},recover:async()=>{},cancel:async()=>({remoteStopped:false}),login:async()=>({state:'ready'}),close:async()=>{}};
  const principal={agentId:DOT_EVENTS_AGENT,principalId:'bot:fixture'};
  const events=new Events({store,isPrincipalActive:()=>true,webhookFetch:async()=>{posts++;return new Response('{}',{status:200});},retryDelaysMs:[]});
  const addSub=(id='sub_original')=>store.commit(s=>{s.subscriptions[id]={id,agentId:DOT_EVENTS_AGENT,principalId:principal.principalId,active:true,expiresAt:Date.now()+86400000,url:'https://callback.example/events',secret:store.seal('whsec_dGVzdC1ldmVudC1zaWduaW5nLXNlY3JldA==')};});
  addSub();
  const channel=createDotsChannel({direct,tunnel,store,events,getConfig:()=>({...config}),setConfig:patch=>Object.assign(config,patch)});
  const manager=new RuntimeManager({store,projectRoot:dir,adapters:{'dots-direct':channel}});
  const jobs=new Jobs({store,events,publicUrl:''});
  const input=(id='run-one')=>({id,idempotencyKey:'key-'+id,taskId:'chat:'+id,title:'Group message',instruction:'Respond in the current room',context:'only-current-room',agentId:DOT_EVENTS_AGENT,protocol:'dots-direct',sessionId:'sub_original'});
  t.after(async()=>{await events.close();await manager.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,events,channel,manager,jobs,input,principal,addSub,config,health,direct,stats:()=>({starts,posts,directStarts})};
}

test('event readiness requires healthy tunnel and exactly one verified subscription; reading never starts it',async t=>{
  const f=fixture(t);
  const ready=await f.channel.status();assert.equal(ready.readiness,'ready');assert.equal(ready.agentId,DOT_EVENTS_AGENT);assert.equal(ready.sessionId,'sub_original');assert.match(ready.connectionIdentity,/^[a-f0-9]{64}$/);
  f.health.state='starting';assert.equal((await f.channel.status()).readiness,'connecting');
  f.health.state='ready';f.store.commit(s=>{s.subscriptions.sub_original.active=false;});
  assert.equal((await f.channel.status()).readiness,'needs_subscription');assert.equal(f.stats().starts,0);
});
test('a device-proof rejection falls back to official events without a second account login',async t=>{
  const f=fixture(t,'direct');
  f.direct.status=async()=>({readiness:'blocked',reason:'device_verification_required',installed:true,message:'private detail must not leak'});
  f.health.state='idle';f.store.commit(s=>{s.subscriptions.sub_original.active=false;});
  const state=await f.channel.status();
  assert.equal(state.transport,'events');assert.equal(state.readiness,'unavailable');assert.equal(state.official,true);
  assert.equal(f.config.transport,'events');
  await assert.rejects(f.manager.create({...f.input(),sessionId:'sub_original'}),e=>e.code==='unavailable');
  assert.equal(f.stats().directStarts,0);assert.equal(f.stats().posts,0);
});
test('an unset transport defaults to official events without contacting the direct account',async t=>{
  const f=fixture(t);delete f.config.transport;
  let reads=0;f.direct.status=async()=>{reads++;return {readiness:'ready'};};
  const state=await f.channel.status();assert.equal(state.transport,'events');assert.equal(state.readiness,'ready');assert.equal(reads,0);
});

test('direct login and original conversation remain a separate unchanged transport',async t=>{
  const f=fixture(t,'direct');f.health.state='failed';
  assert.equal((await f.channel.status()).readiness,'ready');
  const input={...f.input(),agentId:'original-dot',sessionId:''};await f.manager.create(input);
  await until(()=>f.store.data.runs[input.id].status==='review');
  assert.equal(f.stats().directStarts,1);assert.equal(f.stats().posts,0);
});
test('official event dispatch persists its binding, returns MCP result, and is idempotent',async t=>{
  const f=fixture(t),input=f.input();await f.manager.create(input);
  await until(()=>f.store.data.runs[input.id].eventBinding&&f.stats().posts===1);
  const replay=await f.manager.create(input);assert.equal(replay.created,false);
  const task=f.jobs.tool(f.principal,'get_task',{run_id:input.id});assert.equal(task.context,'only-current-room');
  f.jobs.tool(f.principal,'claim_task',{run_id:input.id});
  f.jobs.tool(f.principal,'submit_result',{run_id:input.id,idempotency_key:'answer-one',text:'This is the original Dot reply.'});
  const result=f.manager.get(input.id);assert.equal(result.status,'review');assert.equal(result.result,'This is the original Dot reply.');
  assert.equal(Object.keys(f.store.data.outbox).length,1);assert.equal(f.stats().posts,1);
});
test('old subscription cannot expose messages to a newly bound Dot',async t=>{
  const f=fixture(t),input=f.input();await f.manager.create(input);await until(()=>f.store.data.runs[input.id].eventBinding);
  const oldIdentity=(await f.channel.status()).connectionIdentity;
  f.store.commit(s=>{s.subscriptions.sub_original.active=false;});f.addSub('sub_new');
  assert.notEqual((await f.channel.status()).connectionIdentity,oldIdentity);
  assert.deepEqual(f.jobs.tool(f.principal,'list_tasks').tasks,[]);
  assert.throws(()=>f.jobs.tool(f.principal,'get_task',{run_id:input.id}),e=>e.code==='task_not_found');
});
test('a session change before queueing rejects the request without sending',async t=>{
  const f=fixture(t);f.store.commit(s=>{s.subscriptions.sub_original.active=false;});f.addSub('sub_new');
  await assert.rejects(f.manager.create(f.input()),e=>e.code==='account_changed');assert.equal(f.stats().posts,0);assert.equal(Object.keys(f.store.data.runs).length,0);
});
test('event transport rejects an unsaved direct profile and active jobs block reconfiguration',async t=>{
  const f=fixture(t);await assert.rejects(f.manager.create({...f.input(),agentId:'old-dot'}),e=>e.code==='needs_agent_connection');
  await f.manager.create(f.input());
  await assert.rejects(f.channel.configure({transport:'direct'}),e=>e.code==='agent_busy');
  assert.equal(f.config.transport,'events');
});
test('cancellation closes pending notifications and never claims the remote Dot stopped',async t=>{
  const f=fixture(t);f.events.closed=true;const input=f.input();await f.manager.create(input);await until(()=>Object.keys(f.store.data.outbox).length===1);
  const cancelled=await f.manager.cancel(input.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.remoteStopped,false);
  assert.equal(Object.values(f.store.data.outbox)[0].status,'closed');assert.equal(f.stats().posts,0);
});
test('recovery reads the original dispatch and never creates a replacement event',async t=>{
  const f=fixture(t),input=f.input();await f.manager.create(input);await until(()=>f.stats().posts===1&&Object.values(f.store.data.outbox)[0]?.status==='accepted');
  const before=structuredClone(f.store.data.outbox);
  await f.channel.recover(structuredClone(f.store.data.runs[input.id]),()=>{});
  assert.deepEqual(f.store.data.outbox,before);assert.equal(f.stats().posts,1);
  await f.channel.recover({...f.store.data.runs[input.id],id:'never-dispatched'},e=>assert.equal(e.type,'failed'));
  assert.equal(Object.keys(f.store.data.outbox).length,1);
});
test('event run survives runtime manager restart with its original durable delivery',async t=>{
  const f=fixture(t),input=f.input();f.events.closed=true;await f.manager.create(input);await until(()=>Object.keys(f.store.data.outbox).length===1);
  await f.manager.close();assert.equal(f.store.data.runs[input.id].status,'queued');
  const restored=new RuntimeManager({store:f.store,projectRoot:f.dir,adapters:{'dots-direct':f.channel}});
  assert.equal(restored.get(input.id).status,'queued');assert.equal(Object.keys(f.store.data.outbox).length,1);await restored.close();
});
test('MCP queue cannot read a direct runtime task even with a matching agent ID',async t=>{
  const f=fixture(t);f.store.commit(s=>{s.runs.private={id:'private',agentId:DOT_EVENTS_AGENT,protocol:'dots-direct',runtimeData:{transport:'direct'},context:'private-other-route'};});
  assert.deepEqual(f.jobs.tool(f.principal,'list_tasks').tasks,[]);
  assert.throws(()=>f.jobs.tool(f.principal,'get_task',{run_id:'private'}),e=>e.code==='task_not_found');
});
test('manual stop persists and only explicitly enabled tunnel resumes',async t=>{
  const f=fixture(t);await f.channel.configure({transport:'events',action:'stop'});assert.equal(f.config.tunnelEnabled,false);
  await f.channel.resume();assert.equal(f.stats().starts,0);
  await f.channel.configure({transport:'events',action:'start'});assert.equal(f.stats().starts,1);assert.equal(f.config.tunnelEnabled,true);
});
test('direct chat can resume and start the official MCP tunnel without changing its identity',async t=>{
  const f=fixture(t,'direct');f.health.state='idle';
  await f.channel.resume();assert.equal(f.stats().starts,1);
  assert.equal(f.config.transport,'direct');assert.equal((await f.channel.status()).connectionIdentity,'direct-account');
  await f.channel.configure({transport:'direct',action:'stop'});
  await f.channel.resume();assert.equal(f.stats().starts,1);assert.equal(f.config.tunnelEnabled,false);
  await f.channel.configure({transport:'direct',action:'start'});
  assert.equal(f.stats().starts,2);assert.equal(f.config.transport,'direct');
  assert.equal(f.stats().posts,0);assert.equal(f.stats().directStarts,0);
});
test('switching to direct chat keeps the already enabled MCP tunnel running',async t=>{
  const f=fixture(t);
  await f.channel.configure({transport:'direct'});
  assert.equal(f.health.state,'ready');assert.equal(f.config.tunnelEnabled,true);
  assert.equal(f.config.transport,'direct');assert.equal(f.stats().posts,0);
});
test('bridge startup resumes a saved enabled tunnel even while chat remains direct',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-direct-tunnel-start-'));
  const file=path.join(directory,'state.json'),token='test-admin-token-at-least-24-characters';
  const store=new Store(file,token);store.commit(s=>{s.runtime={providers:{'dots-direct':{config:{transport:'direct',tunnelEnabled:true},secrets:{}}}};});store.close();
  let starts=0;const adapter={resume:async()=>{starts++;},close:async()=>{}};
  const bridge=await createBridge({storePath:file,adminToken:token,runtimeAdapters:{'dots-direct':adapter}});
  t.after(async()=>{await bridge.close();fs.rmSync(directory,{recursive:true,force:true});});
  await bridge.listen(0,'127.0.0.1');await until(()=>starts===1);
  assert.equal(starts,1);
});
test('concurrent preparation cannot enqueue two tasks for the same original Dot',async t=>{
  const f=fixture(t);const result=await Promise.allSettled([f.manager.create(f.input('one')),f.manager.create(f.input('two'))]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(result.find(r=>r.status==='rejected').reason.code,'agent_busy');
  assert.equal(Object.keys(f.store.data.runs).length,1);
});
test('crash before durable outbox creation becomes recoverable without automatic dispatch',async t=>{
  const f=fixture(t);f.store.commit(s=>{s.runs['crash-before-event']={...f.input('crash-before-event'),status:'queued',deliveryStatus:'pending',runtimeData:{transport:'events'},updatedAt:Date.now()};});
  const restored=new RuntimeManager({store:f.store,projectRoot:f.dir,adapters:{'dots-direct':f.channel}});
  assert.equal(f.store.data.runs['crash-before-event'].status,'interrupted');
  restored.get('crash-before-event');await until(()=>f.store.data.runs['crash-before-event'].status==='failed');
  assert.equal(f.stats().posts,0);assert.equal(Object.keys(f.store.data.outbox).length,0);await restored.close();
});
test('a different tunnel cannot recover old private context by reusing the same callback subscription ID',async t=>{
  const f=fixture(t),input=f.input();await f.manager.create(input);await until(()=>f.store.data.runs[input.id].eventBinding);
  f.store.commit(s=>{s.runtime.providers['dots-direct'].config.tunnelId='different_tunnel';});
  assert.deepEqual(f.jobs.tool(f.principal,'list_tasks').tasks,[]);
  assert.throws(()=>f.jobs.tool(f.principal,'get_task',{run_id:input.id}),e=>e.code==='task_not_found');
});
test('local health and an old subscription cannot claim a fresh tunnel is connected',async t=>{
  const f=fixture(t);f.health.startedAt=Date.now()+1;
  const waiting=await f.channel.status();assert.equal(waiting.readiness,'needs_validation');assert.equal(waiting.tunnel.state,'starting');
  f.store.commit(s=>{s.agents[DOT_EVENTS_AGENT].lastSeenAt=f.health.startedAt;});
  const ready=await f.channel.status();assert.equal(ready.readiness,'ready');assert.equal(ready.tunnel.state,'ready');
});
