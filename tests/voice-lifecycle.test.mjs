import assert from 'node:assert/strict';
import test from 'node:test';
import {RealtimeAssistant, GatewayAPIError, requestMicrophone} from '../src/lib/vendor/realtime-client.mjs';

const tick = () => new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function environment(t, getUserMedia) {
  const peers=[], tracks=[];
  class Peer extends EventTarget {
    iceGatheringState='complete'; connectionState='connected'; localDescription={sdp:'v=0'};
    constructor(){super();peers.push(this);}
    createDataChannel(){const dc=this.channel=new EventTarget();dc.readyState='open';dc.send=()=>{};dc.close=()=>{dc.readyState='closed';};return dc;}
    addTrack(){} async createOffer(){return {sdp:'v=0'};} async setLocalDescription(){} async setRemoteDescription(){}
    close(){this.connectionState='closed';}
  }
  const globals={isSecureContext:true,RTCPeerConnection:Peer,navigator:{mediaDevices:{getUserMedia:getUserMedia||async function(){const track={enabled:true,stopped:false,stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};}}}};
  const originals=Object.fromEntries(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,value});
  t.after(()=>{for(const [key,value] of Object.entries(originals)){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  return {peers,tracks};
}
const options = audio=>({baseUrl:'http://localhost',apiKey:'test-only',audioElement:audio||{pause(){},play:async()=>{}}});
const session = id=>({status:201,payload:{id,answer_sdp:'v=0',expires_at:Date.now()/1000+1800}});

test('stopping from a failure event cannot resurrect the old client retry loop',async t=>{
  environment(t);
  const client=new RealtimeAssistant({...options(),maxReconnects:Infinity,transport:async()=>{throw new Error('无法连接语音服务，请检查地址与网络');}});
  let retries=0;
  client.reconnect=async()=>{retries++;};
  client.addEventListener('error',()=>void client.stop());
  await client.start();
  await client.stop();
  assert.equal(retries,0);assert.equal(client.wanted,false);
});

test('replacement waits for a late session and release; stale audio and captions cannot take over',async t=>{
  const {peers,tracks}=environment(t);
  const created=deferred(), deleting=deferred();
  const audio={srcObject:null,pause(){},play:async()=>{}};
  let posts=0, deletes=0, captions=0;
  const old=new RealtimeAssistant({...options(audio),transport:async(path,request)=>{
    if(request.method==='POST'){posts++;return created.promise;}
    if(request.method==='DELETE'){deletes++;return deleting.promise;}
    return {status:200,payload:{}};
  }});
  const next=new RealtimeAssistant({...options(audio),transport:async(path,request)=>{
    if(request.method==='POST'){posts++;return session('new');}
    return {status:request.method==='DELETE'?204:200,payload:{}};
  }});
  t.after(async()=>{await old.stop();await next.stop();});
  old.addEventListener('caption',()=>captions++);
  const opening=old.start();while(!posts)await tick();
  const oldTrack=peers[0].ontrack, oldMessage=peers[0].channel.onmessage;
  let ended=false;
  const stopping=old.stop().then(()=>{ended=true;});
  const replacing=stopping.then(()=>next.start());
  await tick();assert.equal(ended,false);assert.equal(posts,1);assert.ok(tracks.every(t=>t.stopped));
  created.resolve(session('old'));while(!deletes)await tick();
  assert.equal(posts,1);assert.equal(ended,false);
  deleting.resolve({status:204,payload:null});
  await Promise.all([opening,replacing]);assert.equal(posts,2);assert.equal(deletes,1);
  const newAudio={id:'new audio'};audio.srcObject=newAudio;
  oldTrack({streams:[{id:'stale audio'}]});
  oldMessage({data:JSON.stringify({type:'chat_message_delta',delta:{v:{message:{id:'old',author:{role:'assistant'},content:{parts:['old answer']}}}}})});
  assert.equal(audio.srcObject,newAudio);assert.equal(captions,0);
  assert.equal(tracks.filter(t=>!t.stopped).length,1);
  assert.equal(peers[0].ontrack,null);assert.equal(peers[0].channel.onmessage,null);
});

test('canceling microphone permission settles immediately and closes a late approved stream',async t=>{
  const approved=deferred();environment(t,()=>approved.promise);
  const controller=new AbortController();let stopped=0;
  const pending=requestMicrophone(20000,controller.signal);
  controller.abort();await assert.rejects(pending,/连接已取消/);
  approved.resolve({getTracks:()=>[{stop(){stopped++;}}]});await tick();assert.equal(stopped,1);
});

test('overlapping stop requests release one session and preserve unconfirmed cleanup for retry',async()=>{
  const release=deferred();let requests=0;
  const client=new RealtimeAssistant(options());client.wanted=true;client.session={id:'owned'};
  client.request=async()=>{requests++;await release.promise;throw new GatewayAPIError(503,{message:'offline',retryable:true});};
  const one=client.stop(),two=client.stop();assert.equal(one,two);assert.equal(requests,1);
  release.resolve();await one;
  await assert.rejects(client.start(),/尚未释放/);assert.equal(client.unreleased.size,1);
  client.request=async()=>{requests++;return null;};await client.stop();assert.equal(client.unreleased.size,0);assert.equal(requests,2);
});

test('24 hours of gateway renewal keep one web session, one microphone and no repeated greeting',async t=>{
  const {tracks}=environment(t);
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:Date.UTC(2026,8,15,0)});
  let created=0,renewals=0,deletes=0;const resumed=[];
  const client=new RealtimeAssistant({...options(),maxReconnects:Infinity,transport:async(path,request)=>{
    if(path==='/v1/capabilities')return {status:200,payload:{session_renewal:true,backend:'chatgpt_web'}};
    if(path.endsWith('/renew')){renewals++;return {status:200,payload:{id:'same-web-session',expires_at:Date.now()/1000+1800}};}
    if(request.method==='POST'){created++;return session('same-web-session');}
    if(request.method==='DELETE'){deletes++;return {status:204,payload:null};}
    throw new Error('unexpected '+path);
  }});
  client.getContext=async status=>{resumed.push(status.resumed);return '今天早上完成番薯工作包';};
  t.after(()=>client.stop());client.mute(true);await client.start();
  for(let i=0;i<4321;i++){t.mock.timers.tick(20000);await tick();}
  assert.equal(created,1);assert.equal(renewals,4321);assert.equal(deletes,0);
  assert.deepEqual(resumed,[false]);assert.equal(tracks.length,1);assert.equal(tracks[0].enabled,false);assert.equal(tracks[0].stopped,false);
  await client.stop();assert.equal(deletes,1);assert.equal(tracks[0].stopped,true);
  t.mock.timers.tick(3600000);await tick();assert.equal(renewals,4321);assert.equal(created,1);
});

test('a genuine web disconnect releases the old call before recovering fresh context and mute intent',async t=>{
  const {peers,tracks}=environment(t);t.mock.timers.enable({apis:['setTimeout','setInterval']});
  let created=0,active=0;const received=[],contexts=[];
  const client=new RealtimeAssistant({...options(),maxReconnects:Infinity,transport:async(path,request)=>{
    if(path==='/v1/capabilities')return {status:200,payload:{session_renewal:true}};
    if(request.method==='DELETE'){active--;return {status:204,payload:null};}
    if(request.method==='POST'){assert.equal(active,0);active++;created++;return session('web-'+created);}
    return {status:200,payload:{}};
  }});
  client.getContext=async status=>{received.push(status.resumed);return contexts.length?'早上的工作包；下午新增构建结果':'早上的工作包';};
  client.addEventListener('sent',()=>contexts.push(client.context));client.mute(true);t.after(()=>client.stop());await client.start();
  peers[0].connectionState='failed';peers[0].onconnectionstatechange();await tick();
  assert.equal(active,0);assert.equal(tracks[0].stopped,true);
  t.mock.timers.tick(1000);await tick();assert.equal(created,2);assert.equal(active,1);
  assert.deepEqual(received,[false,true]);assert.match(contexts[1],/下午新增构建结果/);assert.equal(tracks[1].enabled,false);
});

test('older gateways keep the expiration fallback and do not receive unsupported renewal requests',async t=>{
  environment(t);t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:Date.UTC(2026,8,15)});
  let created=0;const methods=[];
  const client=new RealtimeAssistant({...options(),maxReconnects:Infinity,transport:async(path,request)=>{
    methods.push([path,request.method]);if(request.method==='POST'){created++;return session('legacy-'+created);}
    return {status:request.method==='DELETE'?204:200,payload:{}};
  }});
  t.after(()=>client.stop());await client.start();t.mock.timers.tick(1800000);await tick();t.mock.timers.tick(1000);await tick();
  assert.equal(created,2);assert.ok(methods.every(([path])=>!path.endsWith('/renew')));
});

test('a transient renewal failure keeps healthy media; late renewal after stop cannot rearm expiry',async t=>{
  const {tracks}=environment(t);t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:Date.UTC(2026,8,15)});
  let posts=0,renewals=0;const late=deferred();
  const client=new RealtimeAssistant({...options(),transport:async(path,request)=>{
    if(path==='/v1/capabilities')return {status:200,payload:{session_renewal:true}};
    if(path.endsWith('/renew')){renewals++;if(renewals===1)throw new Error('offline');return late.promise;}
    if(request.method==='POST'){posts++;return session('one');}
    return {status:204,payload:null};
  }});
  t.after(()=>client.stop());await client.start();t.mock.timers.tick(20000);await tick();
  assert.equal(posts,1);assert.equal(tracks[0].stopped,false);assert.equal(client.wanted,true);
  t.mock.timers.tick(20000);await tick();assert.equal(renewals,2);await client.stop();
  late.resolve({status:200,payload:{id:'one',expires_at:Date.now()/1000+1800}});await tick();
  t.mock.timers.tick(3600000);await tick();assert.equal(posts,1);assert.equal(client.wanted,false);assert.equal(tracks[0].stopped,true);
});
