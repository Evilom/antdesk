// Dev-only journal acceptance, with an isolated native QA identity or in-memory browser fixture.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {isTauri} from '@tauri-apps/api/core';
import {getIdentifier} from '@tauri-apps/api/app';
import ConversationDay from './components/ConversationDay';
import {activateConversation,dayContext,recordObservations,type DayContext} from './lib/continuity';
import {saveMessages,loadHistory} from './lib/pm';
import {applyTheme,useAppStore} from './stores/appStore';
import './App.css';import './liquid.css';
const now=Date.now()/1000;
const messages=Array.from({length:16},(_,i)=>({id:`qa-day-${i}`,role:i%2?'assistant' as const:'user' as const,text:i===0?'验收演示：早上完成番薯工作包初稿。':i===15?'验收演示末尾：明天先核对构建产出，不能把旧构建视为当前版本通过。':`验收演示第 ${i} 条：${'这是用于检查长记录换行和滚动的演示文字，不是大师的真实活动。'.repeat(12)}`}));
const preview:DayContext={conversation:'qa-day',startedAt:now-83000,observedAt:now,since:now-86400,messageCount:messages.length,observationCount:1,scope:'演示数据；仅本对话文字/转写及已接入项目采集，未采集活动未知',messages:messages.map((m,i)=>({...m,kind:m.role,created:now-83000+i*5000,matched:false})),observations:[{id:'project-demo',kind:'project',text:'演示项目采集：工作区有修改；当前提交的构建结果尚未确认。',created:now-3000,matched:false}]};
async function fixture(query:string) {
  if(!isTauri())return {...preview,messages:query?preview.messages.filter(m=>m.text.includes(query)):preview.messages};
  if(await getIdentifier()!=='com.antdesk.pm-qa')throw new Error('验收仅允许隔离的 QA 应用身份');
  let conversation=(await loadHistory()).conversation;
  if(!conversation.startsWith('qa-day-')){conversation='qa-day-'+crypto.randomUUID();await activateConversation(conversation);}
  if(conversation.startsWith('qa-day-')){await saveMessages(conversation,messages);await recordObservations(conversation,[{source:'qa-only',fingerprint:'v1',text:'演示项目采集：工作区有修改，当前提交未验收。'}]);}
  return dayContext(conversation,query);
}
function QA(){const [narrow,setNarrow]=useState(false);return <main className="assistant-layer" style={{position:'absolute',inset:0,width:narrow?320:520,maxWidth:'100%',margin:'auto'}}><header className="assistant-header"><div><h2>本地验收 · 演示记录</h2></div><button className="text-button" onClick={()=>setNarrow(v=>!v)}>320 / 520</button></header><ConversationDay load={fixture} onClose={()=>{}}/></main>;}
if(import.meta.env.DEV){applyTheme(useAppStore.getState().settings);createRoot(document.getElementById('root')!).render(<QA/>);}
