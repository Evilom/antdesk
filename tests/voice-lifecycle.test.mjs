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
