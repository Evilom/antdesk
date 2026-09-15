// Local UI acceptance harness; not a production Vite entry.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {isTauri} from '@tauri-apps/api/core';
import App from './App';
import {DialogueContent} from './components/PetDialogue';
import {publish} from './lib/pm';
import {applyTheme,useAppStore} from './stores/appStore';
import './App.css';
import './liquid.css';
import './dialogue.css';
const long='开头完整保留：这是长回复验收内容，不是实际项目数据。\n\n'+Array.from({length:18},(_,i)=>`${i+1}. 工程进度需要同时核对 Git 提交、工作区改动和构建结果。工作包中的计划状态应保留记录时间与来源。`).join('\n\n')+'\n\n末尾完整保留：请确认可以滚动看到这一行。';
function QA(){const [text,setText]=useState('短回复：今天先核对工程状态。');const [height,setHeight]=useState(180);
return <><div style={{position:'fixed',zIndex:9999,top:4,left:4,display:'flex',gap:8,background:'#202531',padding:8,borderRadius:12,color:'white',fontSize:12}}><span>本地验收 · 演示文字</span>{[['短回复','短回复：今天先核对工程状态。'],['长回复',long]].map(([label,value])=><button key={label} onClick={()=>{setText(value);void publish('pm:voice:status',{state:'connected',muted:true,error:'',caption:value,captionId:crypto.randomUUID()});}}>{label}</button>)}<button onClick={()=>void publish('pm:dialogue:show',null)}>重新展开</button></div>
{isTauri()?<App/>:<div style={{position:'absolute',top:70,left:30,width:340,height:Math.min(height,480)}}><DialogueContent text={text} onResize={setHeight} onClose={()=>setText('已收起')} onOpen={()=>setText(long)}/></div>}</>}
if(import.meta.env.DEV){applyTheme(useAppStore.getState().settings);createRoot(document.getElementById('root')!).render(<QA/>);}
