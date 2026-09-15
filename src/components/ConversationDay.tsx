import {useEffect,useRef,useState} from 'react';
import {ChevronLeft,Search} from 'lucide-react';
import type {DayContext} from '../lib/continuity';
export default function ConversationDay({load,onClose}:{load:(query:string)=>Promise<DayContext>;onClose:()=>void}) {
  const [day,setDay]=useState<DayContext|null>(null),[query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),loader=useRef(load);loader.current=load;
  const refresh=async(q:string)=>{const id=++generation.current;setBusy(true);setError('');try{const result=await loader.current(q);if(id===generation.current)setDay(result);}catch(e){if(id===generation.current)setError(String(e));}finally{if(id===generation.current)setBusy(false);}};
  useEffect(()=>{void refresh('');return()=>{generation.current++;};},[]);
  const entries=day?[...day.messages,...day.observations].sort((a,b)=>a.created-b.created):[];
  return <div className="conversation-day">
    <button className="text-button" onClick={onClose}><ChevronLeft size={15}/>返回对话</button>
    <h3>过去 24 小时</h3><p className="muted-copy">同一条对话一直延续，跨午夜也保留。这里只回看已有记录，不会开启额外录音或屏幕采集。</p>
    <form className="knowledge-search" onSubmit={e=>{e.preventDefault();void refresh(query);}}><Search size={16}/><input aria-label="搜索全天记录" placeholder="找早上的安排、项目进展…" value={query} maxLength={500} onChange={e=>setQuery(e.target.value)}/><button className="text-button" disabled={busy}>{busy?'读取中':'查找'}</button></form>
    {error&&<p className="inline-notice" role="alert">{error}</p>}
    {day&&<p className="muted-copy">{day.messageCount} 条对话 · {day.observationCount} 条项目采集 · 展示 {entries.length} 条节选{query?'（优先匹配关键词）':''}<br/>{day.scope}。24 小时是回看范围，较早记录仍保留。</p>}
    <div className="day-records">{entries.map(e=><article key={e.id}><small>{new Date(e.created*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} · {e.kind==='user'?'你说过':e.kind==='project'?'项目采集':'助理历史回答（未验证）'}</small><p>{e.text}</p></article>)}</div>
    {day&&!entries.length&&<p className="muted-copy">这条对话在过去 24 小时还没有记录。</p>}
  </div>;
}
