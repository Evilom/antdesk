import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createGrokAdapter } from '../runtime/grok.mjs';

function options(api,{loggedIn=true}={}) {
  const secrets=new Map(loggedIn?[['credentials',JSON.stringify({accessToken:'fixture-token'})]]:[]);
  let config={};return {getSecret:key=>secrets.get(key),setSecret:(key,value)=>value?secrets.set(key,value):secrets.delete(key),getConfig:()=>config,setConfig:patch=>config={...config,...patch},makeClient:()=>api,pollMs:5,settleMs:0};
}
const baseRun=()=>({id:'dispatch-1',agentId:'bot-1',taskId:'task-1',title:'Plan today',instruction:'Sort priorities',context:'',createdAt:Date.now()-10});
function fakeApi({unconfirmed=false}={}) {
  let sends=0,sent=false,firstTail=true;
  const api={
    getMe:async()=>({userId:'fixture'}),listBots:async()=>({bots:[{id:'bot-1',name:'Existing bot',sessionId:'session-1'}]}),
    listTranscript:async()=>{if(firstTail){firstTail=false;return {generation:1,entries:[{seq:'1',updatedSeq:'1'}]};}return {generation:1,entries:sent?[{seq:'2',updatedSeq:'2',entryId:'user-echo',body:{id:'dispatch-1',kind:'message',role:'user',content:'Plan today'}},{seq:'3',updatedSeq:'3',entryId:'reply-1',body:{kind:'send-message',message:{type:'text',content:'Sorted priorities'}}}]:[]};},
    sendMessage:async value=>{sends++;sent=true;assert.equal(value.messageId,'dispatch-1');if(unconfirmed){const error=new Error('SEND_UNCONFIRMED');error.code='SEND_UNCONFIRMED';throw error;}return {delivery:'accepted-box'};},
    getSendStatus:async()=>({status:'accepted',echoEntryId:'user-echo'}),
    listAgentStatuses:async()=>({statuses:[{agentId:'bot-1',live:{isRunning:false,isComposingMessage:false,isRetrying:false,hasRunningSubagents:false,updatedAtMs:String(Date.now()),staleAfterMs:String(Date.now()+30000)}}]}),
    async *watchBot({signal}) {while(!signal.aborted){yield {type:'heartbeat',data:{}};try{await delay(5,undefined,{signal});}catch{return;}}},
  };
  return {api,get sends(){return sends;}};
}

test('Grok status before login performs no network or credential harvesting',async()=>{
  let touched=0;const adapter=createGrokAdapter(options({getMe:async()=>touched++},{loggedIn:false}));
  assert.equal((await adapter.status()).readiness,'needs_login');assert.equal((await adapter.login('status')).state,'idle');assert.equal(touched,0);await adapter.close();
});

test('browser login stores credentials only after verification and never returns tokens',async()=>{
  let verified=0,polls=0;const opts=options({getMe:async()=>{verified++;return {userId:'fixture'};}},{loggedIn:false});
  opts.fetchImpl=async url=>{polls++;const parsed=new URL(url);assert.equal(parsed.origin,'https://api2.cursor.sh');assert.equal(parsed.pathname,'/auth/poll');assert.ok(parsed.searchParams.get('verifier'));return Response.json({accessToken:'login-fixture-token',refreshToken:'login-fixture-refresh',selectedTeamId:42});};
  const adapter=createGrokAdapter(opts);const started=await adapter.login('start');assert.equal(started.state,'pending');assert.equal(new URL(started.url).origin,'https://cursor.com');assert.equal(new URL(started.url).searchParams.has('verifier'),false);
  await delay(10);const status=await adapter.login('status');assert.equal(status.state,'ready');assert.equal(verified,1);assert.equal(polls,1);assert.ok(!JSON.stringify(status).includes('fixture-token'));assert.equal(JSON.parse(opts.getSecret('credentials')).teamId,42);
  await adapter.login('logout');assert.equal((await adapter.status()).readiness,'needs_login');assert.equal(opts.getSecret('credentials'),undefined);await adapter.close();
});

test('Grok returns original Bot identity and completes only after a fresh idle state',async()=>{
  const fake=fakeApi(),adapter=createGrokAdapter(options(fake.api)),events=[];
  assert.equal((await adapter.agents()).agents[0].id,'bot-1');
  await adapter.start(baseRun(),event=>events.push(event));
  assert.equal(fake.sends,1);assert.equal(events.find(e=>e.type==='started').sessionId,'session-1');assert.equal(events.at(-1).type,'complete');assert.equal(events.at(-1).text,'Sorted priorities');await adapter.close();
});

test('uncertain Grok sends are queried by the same ID and never resent',async()=>{
  const fake=fakeApi({unconfirmed:true}),adapter=createGrokAdapter(options(fake.api)),events=[];
  await adapter.start(baseRun(),event=>events.push(event));
  assert.equal(fake.sends,1);assert.ok(events.some(e=>e.type==='interrupted'&&e.deliveryStatus==='unknown'));assert.equal(events.at(-1).type,'complete');await adapter.close();
});

test('unknown original Bot fails before sending any user message',async()=>{
  const fake=fakeApi();fake.api.listBots=async()=>({bots:[]});const adapter=createGrokAdapter(options(fake.api)),events=[];
  await adapter.start(baseRun(),event=>events.push(event));assert.equal(fake.sends,0);assert.equal(events.at(-1).type,'failed');assert.equal(events.at(-1).deliveryStatus,'rejected');await adapter.close();
});

test('Grok recovery without a correlation checkpoint refuses a new prompt',async()=>{
  const fake=fakeApi(),adapter=createGrokAdapter(options(fake.api)),events=[];await adapter.recover(baseRun(),event=>events.push(event));assert.equal(fake.sends,0);assert.equal(events.at(-1).type,'interrupted');await adapter.close();
});

test('Grok connection identity survives token renewal but follows account and workspace changes',async()=>{
  let userId='first-user',checks=0;
  const opts=options({getMe:async()=>{checks++;return {authId:userId};}});
  const adapter=createGrokAdapter(opts);
  try{
    const first=await adapter.status();assert.equal(first.readiness,'ready');assert.match(first.connectionIdentity,/^[a-f0-9]{64}$/);
    opts.setSecret('credentials',JSON.stringify({accessToken:'renewed-token'}));
    assert.equal((await adapter.status()).connectionIdentity,first.connectionIdentity);assert.equal(checks,2);
    opts.setSecret('credentials',JSON.stringify({accessToken:'renewed-token',teamId:42}));
    const team=await adapter.status();assert.notEqual(team.connectionIdentity,first.connectionIdentity);
    opts.setSecret('credentials',JSON.stringify({accessToken:'renewed-token',teamId:'42'}));
    assert.equal((await adapter.status()).connectionIdentity,team.connectionIdentity);
    userId='second-user';opts.setSecret('credentials',JSON.stringify({accessToken:'different-user-token',teamId:42}));
    const other=await adapter.status();assert.notEqual(other.connectionIdentity,team.connectionIdentity);
    assert.ok(!JSON.stringify(other).includes('different-user-token'));assert.ok(!JSON.stringify(other).includes('second-user'));
  }finally{await adapter.close();}
});

test('Grok late identity response never exposes a previous login after credentials change',async()=>{
  let release,began;
  const entered=new Promise(resolve=>{began=resolve;});
  const opts=options({});opts.makeClient=auth=>({getMe:async()=>{
    if(auth.accessToken==='fixture-token'){began();return new Promise(resolve=>{release=resolve;});}
    return {userId:'new-user'};
  }});
  const adapter=createGrokAdapter(opts);
  try{
    const old=adapter.status();await entered;
    opts.setSecret('credentials',JSON.stringify({accessToken:'new-token'}));
    const current=await adapter.status();assert.equal(current.readiness,'ready');
    release({userId:'old-user'});const stale=await old;assert.equal(stale.readiness,'connecting');assert.equal(stale.connectionIdentity,undefined);
    assert.equal((await adapter.status()).connectionIdentity,current.connectionIdentity);
  }finally{await adapter.close();}
});

test('Grok stale getMe rejection does not report the new login as expired',async()=>{
  let rejectOld,began;const entered=new Promise(resolve=>{began=resolve;});
  const opts=options({});opts.makeClient=auth=>({getMe:async()=>{
    if(auth.accessToken==='fixture-token'){began();return new Promise((_resolve,reject)=>{rejectOld=reject;});}
    return {userId:'new-user'};
  }});
  const adapter=createGrokAdapter(opts);
  try{
    const pending=adapter.status();await entered;opts.setSecret('credentials',JSON.stringify({accessToken:'new-token'}));
    const current=await adapter.status();rejectOld(Object.assign(new Error('expired'),{httpStatus:401}));
    const stale=await pending;assert.equal(stale.readiness,'connecting');assert.equal(stale.connectionIdentity,undefined);
    assert.equal((await adapter.status()).connectionIdentity,current.connectionIdentity);
  }finally{await adapter.close();}
});

test('Grok closed adapter and missing account identity cannot claim a verified connection',async()=>{
  const invalid=createGrokAdapter(options({getMe:async()=>({})}));
  const missing=await invalid.status();assert.notEqual(missing.readiness,'ready');assert.equal(missing.connectionIdentity,undefined);await invalid.close();
  let release,began;const entered=new Promise(resolve=>{began=resolve;});
  const adapter=createGrokAdapter(options({getMe:async()=>{began();return new Promise(resolve=>{release=resolve;});}}));
  const pending=adapter.status();await entered;await adapter.close();release({userId:'stale-user'});
  const closed=await pending;assert.equal(closed.readiness,'unavailable');assert.equal(closed.connectionIdentity,undefined);
});
