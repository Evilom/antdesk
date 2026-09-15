import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {INITIAL_VOICE,publish,subscribe,type VoiceStatus} from '../lib/pm';

export function DialogueContent({text,onClose,onOpen,onResize}:{text:string;onClose:()=>void;onOpen:()=>void;onResize?:(height:number)=>void}) {
  const content=useRef<HTMLDivElement>(null);
  const scrolling=useRef<HTMLDivElement>(null);
  const following=useRef(true);
  useEffect(()=>{
    const node=content.current;if(!node)return;
    const resize=()=>onResize?.(Math.ceil(node.getBoundingClientRect().height)+78);
    const observer=new ResizeObserver(resize);observer.observe(node);resize();return()=>observer.disconnect();
  },[onResize]);
  useEffect(()=>{if(following.current&&scrolling.current)scrolling.current.scrollTop=scrolling.current.scrollHeight;},[text]);
  return <section className="pet-dialogue" aria-label="助理完整回复">
    <header><span>AntDesk · 助理回复</span><button aria-label="收起回复" onClick={onClose}>×</button></header>
    <div className="pet-dialogue-scroll" ref={scrolling} tabIndex={0} aria-label="回复内容，可滚动阅读" onScroll={()=>{
      const el=scrolling.current!;following.current=el.scrollHeight-el.scrollTop-el.clientHeight<28;
    }}><div ref={content} className="pet-dialogue-text">{text}</div></div>
    <footer><span>长回复可滚动、选择复制</span><button onClick={onOpen}>完整对话 ↗</button></footer>
  </section>;
}

export default function PetDialogue() {
  const [status,setStatus]=useState<VoiceStatus>(INITIAL_VOICE);
  const [visible,setVisible]=useState(false);
  const dismissed=useRef('');const current=useRef(INITIAL_VOICE);const showRef=useRef(false);
  const size=useRef(180);const pending=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resizeRef=useRef((height:number)=>{
    size.current=height;
    if(pending.current)clearTimeout(pending.current);
    pending.current=setTimeout(()=>{if(isTauri()&&showRef.current)void invoke('resize_pet_dialogue',{height:size.current}).catch(()=>{});},60);
  });
  const hide=()=>{dismissed.current=current.current.error?`error:${current.current.error}`:current.current.captionId||current.current.caption;showRef.current=false;setVisible(false);if(isTauri())void getCurrentWindow().hide();};
  useEffect(()=>{
    let disposed=false;const off:Array<()=>void>=[];
    const show=()=>{showRef.current=true;setVisible(true);resizeRef.current(size.current);};
    const subscriptions=[subscribe<VoiceStatus>('pm:voice:status',value=>{
      current.current=value;setStatus(value);
      const id=value.error?`error:${value.error}`:value.captionId||value.caption;
      if(id!==dismissed.current&&(value.error||(!['idle','disconnected'].includes(value.state)&&value.caption)))show();
    }),subscribe('pm:dialogue:show',()=>{dismissed.current='';if(current.current.caption||current.current.error)show();})];
    void Promise.all(subscriptions).then(fns=>{if(disposed)fns.forEach(fn=>fn());else{off.push(...fns);void publish('pm:voice:request',null);}});
    return()=>{disposed=true;off.forEach(fn=>fn());if(pending.current)clearTimeout(pending.current);};
  },[]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape')hide();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  if(!visible)return null;
  return <DialogueContent text={status.error||status.caption} onResize={resizeRef.current} onClose={hide} onOpen={()=>{void publish('pm:open-assistant',null);hide();}}/>;
}
