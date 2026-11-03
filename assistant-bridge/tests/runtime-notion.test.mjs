import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createNotionWebAdapter, NOTION_UPSTREAM_COMMIT } from '../runtime/notion-web.mjs';
import { hash } from '../lib/util.mjs';

const cookies = 'token_v2=offline-only; notion_user_id=user-one';
const identity = (workspaceId='space-one') => ({initialized:true,sdkVersion:NOTION_UPSTREAM_COMMIT,
  account:{id:'user-one',name:'User'},workspaces:[{id:'space-one',name:'Work'},{id:'space-two',name:'Personal'}],workspaceId,
  models:[{id:'account-model',name:'Account Model'}],modelsSource:'account'});
const run = (extra={}) => ({id:'run-one',taskId:'task-one',agentId:'notion-web',protocol:'notion-web',title:'Review',instruction:'Review this priority',context:'Only this room',model:'auto',deliveryStatus:'pending',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-notion-test-'));let secret=options.empty?undefined:cookies;
  let config=options.empty?{}:{authState:'ready',account:identity().account,workspaces:identity().workspaces,workspaceId:'space-one',models:identity().models,modelsSource:'account',credentialFingerprint:hash(cookies),model:'auto'};
  const calls=[],transports=[],settings=[];
  class Rpc extends EventEmitter {
    closed=false;
    async open(){return this;}
    async call(method,params={}) {
      calls.push({method,params});
      if(options.call){const custom=await options.call(method,params,this);if(custom!==undefined)return custom;}
      if(method==='initialize')return identity(params.workspaceId);
      if(method==='chat/send'||method==='chat/recover'){
        if(method==='chat/send')this.emit('notification','notion/started',{runId:params.runId,threadId:params.threadId});
        this.emit('notification','notion/message',{runId:params.runId,threadId:params.threadId,text:'Working',complete:false});
        return {completed:true,threadId:params.threadId,text:'Verified review response'};
      }
      return {};
    }
    async close(){this.closed=true;this.emit('disconnect');}
  }
  const adapter=createNotionWebAdapter({projectRoot:dir,dataDir:path.join(dir,'data'),toolsDir:path.join(dir,'tools'),
    getSecret:key=>{assert.equal(key,'cookies');return secret;},setSecret:(_key,value)=>{secret=value;},
    getConfig:()=>structuredClone(config),setConfig:patch=>{config={...config,...patch};},
    transportFactory:input=>{settings.push(input);const rpc=new Rpc();transports.push(rpc);return rpc;},
    browserLoginFactory:options.browserLoginFactory,
  });
  t.after(async()=>{await adapter.close();fs.rmSync(dir,{recursive:true,force:true});});
  return{adapter,calls,transports,settings,getConfig:()=>config,setConfig:patch=>{config={...config,...patch};},
    secret:()=>secret,async prepared(extra={}){const value=run(extra);return{...value,runtimeData:adapter.prepare(value,await adapter.status())};}};
}

test('a logged-out status never opens a worker or reports member entitlement',async t=>{
  const f=fixture(t,{empty:true});const state=await f.adapter.status();
  assert.equal(state.readiness,'needs_login');assert.equal(state.official,false);assert.equal(f.calls.length,0);
  assert.equal(state.aiVerified,undefined);assert.equal(JSON.stringify(state).includes('token_v2'),false);
});

test('verified login exposes identity and workspaces without credentials, and keeps AI untested',async t=>{
  const f=fixture(t);const state=await f.adapter.status();
  assert.equal(state.readiness,'ready');assert.equal(state.aiVerified,false);assert.equal(state.modelsSource,'account');
  assert.ok(state.message.includes('首次真实回复'));assert.equal(JSON.stringify(state).includes('offline-only'),false);
  const before=state.connectionIdentity;f.setConfig({workspaceId:'space-two'});
  assert.notEqual((await f.adapter.status()).connectionIdentity,before);
});

test('refresh reads identity without sending a prompt and selected workspace scopes connection',async t=>{
  const f=fixture(t);await f.adapter.configure({workspaceId:'space-two',action:'refresh'});
  assert.deepEqual(f.calls.map(x=>x.method),['initialize','shutdown']);assert.equal(f.getConfig().workspaceId,'space-two');
  assert.equal(f.calls[0].params.workspaceId,'space-two');assert.equal(f.settings[0].args[0],'-I');
  assert.equal(f.settings[0].env.NOTION_COOKIE,undefined);
});

test('dispatch persists an intent before sending and only an explicit completed reply becomes review',async t=>{
  let intent=false;const f=fixture(t,{call(method){if(method==='chat/send')assert.equal(intent,true);}});
  const work=await f.prepared(),events=[];
  await f.adapter.start(work,event=>{events.push(event);if(event.type==='checkpoint'&&event.data.sendIntent)intent=true;});
  assert.equal(f.calls.filter(x=>x.method==='chat/send').length,1);
  const request=f.calls.find(x=>x.method==='chat/send').params;
  assert.equal(request.model,'auto');assert.ok(request.text.includes('Only this room'));assert.ok(request.text.includes('不要修改 Notion'));
  assert.ok(events.some(x=>x.type==='started'));assert.equal(events.at(-1).type,'complete');assert.equal(f.getConfig().aiVerified,true);
});

test('new requests use independent threads and unverified models are rejected',async t=>{
  const f=fixture(t);const first=await f.prepared(),second=await f.prepared({id:'run-two'});
  assert.notEqual(first.runtimeData.threadId,second.runtimeData.threadId);
  assert.throws(()=>f.adapter.prepare(run({model:'invented-model'}),{...identity(),workspaceId:'space-one'}),/模型/);
  await assert.rejects(f.adapter.configure({model:'invented-model'}),/模型/);
});

test('partial or empty replies never become completed evidence',async t=>{
  for(const result of [{completed:false,text:'partial'},{completed:true,text:''}]){
    const f=fixture(t,{call(method,p){if(method==='chat/send')return {...result,threadId:p.threadId};}});
    const events=[];await f.adapter.start(await f.prepared(),e=>events.push(e));
    assert.equal(events.some(x=>x.type==='complete'),false);assert.equal(events.at(-1).type,'interrupted');
    assert.notEqual(f.getConfig().aiVerified,true);
  }
});

test('send timeout is never retried and recovery only reads the original thread',async t=>{
  const f=fixture(t,{call(method){if(method==='chat/send')throw Object.assign(new Error('private token_v2=must-not-leak'),{code:'RPC_TIMEOUT'});}});
  const work=await f.prepared(),events=[];await f.adapter.start(work,e=>events.push(e));
  assert.equal(f.calls.filter(c=>c.method==='chat/send').length,1);assert.equal(events.at(-1).type,'interrupted');
  assert.equal(JSON.stringify(events).includes('must-not-leak'),false);
  const checkpoint=events.find(e=>e.type==='checkpoint');
  const recovered=[];await f.adapter.recover({...work,runtimeData:{...work.runtimeData,...checkpoint.data}},e=>recovered.push(e));
  assert.equal(f.calls.filter(c=>c.method==='chat/send').length,1);assert.equal(f.calls.filter(c=>c.method==='chat/recover').length,1);
  assert.equal(recovered.at(-1).type,'complete');
});

test('expired credentials and exhausted credits are distinct and secrets never enter errors',async t=>{
  for(const code of ['auth_required','credits_exhausted']){
    const f=fixture(t,{call(method){if(method==='chat/send')throw Object.assign(new Error('private credential'),{data:{code,httpStatus:code==='auth_required'?401:402}});}});
    const events=[];await f.adapter.start(await f.prepared(),e=>events.push(e));
    assert.equal(JSON.stringify(events).includes('private credential'),false);
    assert.equal(f.getConfig().lastIssue,code);
    assert.equal((await f.adapter.status()).readiness,code==='auth_required'?'needs_login':'unavailable');
    assert.equal(f.secret(),cookies,'failure does not delete a saved login');
  }
});

test('a changed account or workspace cannot receive an already prepared task',async t=>{
  const f=fixture(t),work=await f.prepared();f.setConfig({account:{id:'another-user',name:'Other'}});
  const events=[];await f.adapter.start(work,e=>events.push(e));
  assert.equal(f.calls.some(c=>c.method==='chat/send'),false);assert.equal(events.at(-1).type,'interrupted');
});

test('cancellation suppresses late completion and does not claim the remote agent stopped',async t=>{
  const wait=deferred(),entered=deferred();
  const f=fixture(t,{call(method,p){if(method==='chat/send'){entered.resolve();return wait.promise;}}});
  const work=await f.prepared(),events=[];const sending=f.adapter.start(work,e=>events.push(e));await entered.promise;
  assert.equal((await f.adapter.cancel(work)).remoteStopped,false);
  wait.resolve({completed:true,text:'late',threadId:work.runtimeData.threadId});await sending;
  assert.equal(events.some(e=>e.type==='complete'),false);
});

test('login metadata is committed only after the dedicated helper saved the verified login',async t=>{
  let helperOptions;const f=fixture(t,{empty:true,browserLoginFactory:opts=>{helperOptions=opts;return{
    async login(action){if(action==='start'){await opts.verifyCookies(cookies);opts.setSecret('cookies',cookies);return{state:'ready'};}return{state:'idle'};},async close(){}};}});
  assert.equal((await f.adapter.login('start')).state,'ready');
  assert.equal(f.getConfig().account.id,'user-one');assert.equal(f.getConfig().credentialFingerprint,hash(cookies));
  assert.equal(f.getConfig().workspaceId,'');assert.equal((await f.adapter.status()).readiness,'needs_configuration');
  assert.equal(f.calls.some(c=>c.method.startsWith('chat/')),false);
});

test('rechecking a saved login preserves the selected workspace for the same account',async t=>{
  const f=fixture(t,{browserLoginFactory:opts=>({async login(){await opts.verifyCookies(cookies);return{state:'ready'};},async close(){}})});
  f.setConfig({workspaceId:'space-two',aiVerified:true,aiVerifiedModel:'auto'});
  await f.adapter.login('status');
  assert.equal(f.getConfig().workspaceId,'space-two');assert.equal(f.getConfig().aiVerified,true);
  assert.deepEqual(f.calls.filter(c=>c.method==='initialize').map(c=>c.params.workspaceId),['','space-two']);
});

test('a new account cannot inherit the previous account workspace or AI verification',async t=>{
  const f=fixture(t,{call(method,p){if(method==='initialize')return{...identity(p.workspaceId),account:{id:'user-two',name:'Other'}};},
    browserLoginFactory:opts=>({async login(){await opts.verifyCookies(cookies);return{state:'ready'};},async close(){}})});
  f.setConfig({aiVerified:true});await f.adapter.login('status');
  assert.equal(f.getConfig().account.id,'user-two');assert.equal(f.getConfig().workspaceId,'');
  assert.equal(f.getConfig().aiVerified,false);assert.equal(f.calls.filter(c=>c.method==='initialize').length,1);
});

test('model configuration clears a rejected model without pretending the replacement is verified',async t=>{
  const f=fixture(t);f.setConfig({lastIssue:'model_unavailable',aiVerified:true,aiVerifiedModel:'rejected'});
  assert.equal((await f.adapter.status()).readiness,'unavailable');
  const result=await f.adapter.configure({model:'auto'});
  assert.equal(result.readiness,'ready');assert.equal(result.aiVerified,false);assert.equal(f.getConfig().lastIssue,'');
});
