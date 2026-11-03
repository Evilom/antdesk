import {useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {useProjectFeed,refreshProjectFeed} from '../lib/project-feed';
import {projectSources} from '../lib/source-status.mjs';
import {useAppStore} from '../stores/appStore';

export default function DataSources({voiceState,memoryError,onProjects,onSettings}:{
  voiceState:string;memoryError:string;
  onProjects:()=>void;onSettings:()=>void;
}) {
  const feed=useProjectFeed();
  const [expanded,setExpanded]=useState(false);
  const projects=()=>{setExpanded(false);onProjects();};
  const {notionConnected,notionSync,settings}=useAppStore();
  const p=projectSources(feed.snapshot,feed.engineeringError);
  return <details className="data-sources" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
    <summary><span>数据源</span><strong>{!isTauri()?'浏览器预览':p.label}</strong><span>状态</span></summary>
    <div className="source-row" data-state={p.state}><div><strong>本地项目</strong><p>{p.detail}</p><small>{feed.snapshot?`更新于 ${new Date(feed.snapshot.observedAt*1000).toLocaleTimeString()}`:'暂无记录'}</small></div><button onClick={projects}>管理</button></div>
    <div className="source-row" data-state={feed.packagesError?'error':'ready'}><div><strong>工作包</strong><p>{feed.packagesError||(!feed.packagesAt?'尚未检查':`${feed.packages.length} 个工作包`)}</p></div><button onClick={projects}>查看</button></div>
    <div className="source-row" data-state={notionConnected?'ready':'empty'}><div><strong>Notion 同步</strong><p>{notionSync.error||(notionConnected?'已同步':settings.notionToken?'已配置，待同步':'未配置')}</p><small>{notionSync.at?`同步于 ${new Date(notionSync.at).toLocaleTimeString()}`:'暂无同步记录'}</small></div><button onClick={onSettings}>设置</button></div>
    <div className="source-row"><div><strong>语音与记忆</strong><p>{voiceState==='connected'?'通话已连接':'未通话'} · {memoryError||(!isTauri()?'预览模式':'本地存储正常')}</p></div><button onClick={onSettings}>设置</button></div>
    <button className="text-button" disabled={feed.checking} onClick={()=>void refreshProjectFeed()}>{feed.checking?'刷新中…':'刷新项目数据'}</button>
  </details>;
}
