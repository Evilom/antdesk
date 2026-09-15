import {useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {useProjectFeed,refreshProjectFeed} from '../lib/project-feed';
import {projectSources} from '../lib/source-status.mjs';
import {useAppStore} from '../stores/appStore';

export default function DataSources({voiceState,knowledge,knowledgeError,memoryError,onProjects,onSettings,onKnowledge}:{
  voiceState:string;knowledge:{authenticated:boolean}|null;knowledgeError:string;memoryError:string;
  onProjects:()=>void;onSettings:()=>void;onKnowledge:()=>void;
}) {
  const feed=useProjectFeed();
  const [expanded,setExpanded]=useState(false);
  const projects=()=>{setExpanded(false);onProjects();};
  const {notionConnected,notionSync,settings}=useAppStore();
  const p=projectSources(feed.snapshot,feed.engineeringError);
  return <details className="data-sources" open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}>
    <summary><span>数据源</span><strong>{!isTauri()?'浏览器预览 · 未连接本机':p.label}</strong><span>查看接入状态</span></summary>
    <div className="source-row" data-state={p.state}><div><strong>本机项目与文档</strong><p>{p.detail}</p><small>{feed.snapshot?`采集于 ${new Date(feed.snapshot.observedAt*1000).toLocaleTimeString()}`:'尚无采集结果'}</small></div><button onClick={projects}>管理项目</button></div>
    <div className="source-row" data-state={feed.packagesError?'error':'ready'}><div><strong>工作包</strong><p>{feed.packagesError||(!feed.packagesAt?'尚未检查':`${feed.packages.length} 个已登记工作包；聊天中的计划不会自动登记`)}</p></div><button onClick={projects}>查看节点</button></div>
    <div className="source-row" data-state={notionConnected?'ready':'empty'}><div><strong>Notion 日程</strong><p>{notionSync.error||(notionConnected?'最近一次同步成功':settings.notionToken?'已配置，尚未同步成功':'尚未配置')}</p><small>{notionSync.at?`成功同步于 ${new Date(notionSync.at).toLocaleTimeString()}`:'无成功同步记录'}</small></div><button onClick={onSettings}>设置</button></div>
    <div className="source-row" data-state={knowledgeError?'error':knowledge?.authenticated?'ready':'empty'}><div><strong>Hermes 知识</strong><p>{!settings.knowledgeEnabled?'关联已关闭':knowledgeError||(!knowledge?'尚未检查':knowledge.authenticated?'本机知识库可访问':'服务存在，鉴权未通过')}</p></div><button onClick={onKnowledge}>检查 / 检索</button></div>
    <div className="source-row"><div><strong>语音与长期记忆</strong><p>{voiceState==='connected'?'语音通话已连接':'语音尚未接通；配置密钥不等于通话成功'}</p><p>{memoryError||(!isTauri()?'本机记忆需要桌面应用':'对话与记忆保存在本机')}</p></div><button onClick={onSettings}>设置</button></div>
    <button className="text-button" disabled={feed.checking} onClick={()=>void refreshProjectFeed()}>{feed.checking?'检查中…':'重新检查项目与工作包'}</button>
  </details>;
}
