// Dev-only, in-process signaling simulation. No real microphone, gateway or stored user data.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {isTauri} from '@tauri-apps/api/core';
import AssistantPanel from './components/AssistantPanel';
import Settings from './components/Settings';
import {RealtimeAssistant} from './lib/vendor/realtime-client.mjs';
import {setVoiceKey, type createVoiceClient} from './lib/assistant';
import {applyTheme,useAppStore} from './stores/appStore';
import './App.css';
import './liquid.css';

if(import.meta.env.DEV&&!isTauri()) {
  let notify=()=>{}, hold=false, nextId=0, created=0, renewals=0, liveMics=0, peakMics=0;
  let release:(()=>void)|null=null, late:(()=>void)|null=null;
  const active=new Set<string>();
  class Peer extends EventTarget {
    iceGatheringState='complete';connectionState='connected';localDescription={sdp:'v=0'};
    ontrack:((event:unknown)=>void)|null=null;onconnectionstatechange:(()=>void)|null=null;
    channel:any;
    createDataChannel(){const dc=this.channel=new EventTarget() as any;dc.readyState='open';dc.close=()=>{dc.readyState='closed';};dc.send=()=>{};return dc;}
    addTrack(){} async createOffer(){return {sdp:'v=0'};} async setLocalDescription(){}
    async setRemoteDescription(){const message=this.channel.onmessage;if(!late)late=()=>message?.({data:JSON.stringify({type:'chat_message_delta',delta:{v:{message:{id:'old-caption',author:{role:'assistant'},content:{parts:['错误：旧通道抢占了新对话']}}}}})});}
    close(){this.connectionState='closed';}
  }
  Object.defineProperty(globalThis,'RTCPeerConnection',{configurable:true,value:Peer});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
    let stopped=false;liveMics++;peakMics=Math.max(peakMics,liveMics);notify();
    const track={enabled:true,stop(){if(!stopped){stopped=true;liveMics--;notify();}}};
    return {getTracks:()=>[track],getAudioTracks:()=>[track]};
  }}});
  void setVoiceKey('qa-demo-no-network');
  const factory:typeof createVoiceClient=(_settings,audio,context)=>new RealtimeAssistant({baseUrl:'http://localhost',apiKey:'qa-demo-no-network',audioElement:audio,context,transport:async(path,request)=>{
    if(path==='/v1/capabilities')return {status:200,payload:{session_renewal:true}};
    if(path.endsWith('/renew')){renewals++;notify();return {status:200,payload:{id:path.split('/').at(-2),expires_at:Date.now()/1000+1800}};}
    if(request.method==='POST'){const id=`qa-${++nextId}`;active.add(id);created++;notify();return {status:201,payload:{id,answer_sdp:'v=0',expires_at:Date.now()/1000+1800}};}
    if(request.method==='DELETE') {if(hold)await new Promise<void>(resolve=>{release=resolve;notify();});active.delete(path.split('/').at(-1)!);notify();return {status:204,payload:null};}
    return {status:200,payload:{}};
  }});
  function QA(){const [,refresh]=useState(0),[settings,setSettings]=useState(false),[voice,setVoice]=useState('idle'),[narrow,setNarrow]=useState(false);notify=()=>refresh(n=>n+1);
    return <><aside style={{position:'fixed',top:0,left:0,width:320,padding:16,zIndex:1000,background:'#202633',color:'white',fontSize:13,display:'grid',gap:12}}><strong>本地模拟 · 不采音、不连接外网</strong><output>服务会话 {active.size} · 麦克风 {liveMics} · 峰值 {peakMics} · 累计连接 {created} · 续期 {renewals}</output><label><input type="checkbox" onChange={e=>{hold=e.target.checked;}}/>延迟释放旧会话</label><button disabled={!release} onClick={()=>{const done=release;release=null;done?.();}}>完成旧会话释放</button><button onClick={()=>late?.()}>注入旧通道迟到回复</button><button onClick={()=>setNarrow(v=>!v)}>切换 320 / 520 宽度</button></aside>
      <main style={{position:'absolute',right:0,top:0,bottom:0,width:narrow?320:520,overflow:'hidden'}}><AssistantPanel open={!settings} onClose={()=>{}} onSettings={()=>setSettings(true)} onState={setVoice} requestBriefing={0} voiceClientFactory={factory}/>{settings&&<section className="settings-sheet" style={{maxWidth:'100%'}}><header className="settings-heading"><h2>设置</h2><button onClick={()=>setSettings(false)}>关闭设置</button></header><Settings voiceState={voice}/></section>}</main></>;
  }
  useAppStore.setState(state=>({settings:{...state.settings,knowledgeEnabled:false,projectBriefingEvents:false,projectBriefingTime:'',autoBriefing:false}}));
  applyTheme(useAppStore.getState().settings);createRoot(document.getElementById('root')!).render(<QA/>);
}
