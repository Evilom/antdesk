import {useEffect, useState} from 'react';
import {useProjectFeed,refreshProjectFeed} from '../lib/project-feed';
import {SourceEditor,WorkSources} from './WorkSources';
import {checkSources} from '../lib/source-status.mjs';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {engineering, workPackages, savePackage, workTimeline, newNode, type Engineering, type WorkPackage, type Revision, type CheckRun, type ProjectFact} from '../lib/cockpit';
import {NODE_LABELS, readyNodes, resultLabel, evidenceLabel} from '../lib/cockpit-data.mjs';
import {TASK_LABELS, type CodexSnapshot} from '../lib/pm';

function CheckRow({run:r,project:p}:{run:CheckRun;project:ProjectFact}) {return <div className="cockpit-check"><span>{r.workflowName||r.label} · <strong>{resultLabel(r)}</strong></span><small>{evidenceLabel(r,p)}</small><small>{time(r.updatedAt||r.completedAt||r.startedAt)}</small>{r.url&&/^https:\/\/github\.com\//.test(r.url)&&<a href={r.url} target="_blank" rel="noreferrer">查看构建来源</a>}</div>;}
const time=(stamp?:number|string)=>stamp?new Date(typeof stamp==='number'?stamp*1000:stamp).toLocaleString(): '尚未记录';
export default function ProjectCockpit({onClose,codex,codexError}:{onClose:()=>void;codex:CodexSnapshot|null;codexError:string}) {
  const {snapshot,packages,engineeringError,packagesError}=useProjectFeed();
  const setPackages=(packages:WorkPackage[])=>useProjectFeed.setState({packages,packagesAt:Date.now()/1000,packagesError:''});
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const [directory,setDirectory]=useState('');const [notice,setNotice]=useState('');
  const [draft,setDraft]=useState<WorkPackage|null>(null);
  const [history,setHistory]=useState<{title:string;rows:Revision[]}|null>(null);
  useEffect(()=>{void refreshProjectFeed();const timer=setInterval(()=>void refreshProjectFeed(),15000);return()=>clearInterval(timer);},[]);
  const refresh=async()=>{await refreshProjectFeed();};
  const action=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const updateNode=(id:string,patch:Partial<WorkPackage['nodes'][number]>)=>setDraft(p=>p&&({...p,nodes:p.nodes.map(n=>n.id===id?{...n,...patch}:n)}));
  const edit=(p:WorkPackage)=>{setDraft(structuredClone(p));setHistory(null);setNotice('');};
  return <div className="project-cockpit">
    <div className="pm-work-heading"><div><h3>项目与工作包</h3></div><button className="text-button" onClick={onClose}>返回对话</button></div>
    <p className="muted-copy">自动同步本地 Git 与 GitHub 构建状态。</p>
    {(error||engineeringError||packagesError)&&<p className="inline-notice" role="alert">{error||engineeringError||packagesError}</p>}
    {notice&&<p className="service-status" role="status">{notice}</p>}
    {!isTauri()&&<p className="inline-notice">当前为浏览器预览，本地项目数据需在桌面端读取。</p>}
    {draft ? <form className="cockpit-editor" onSubmit={e=>{e.preventDefault();void action(async()=>{
      await savePackage(draft);setPackages(await workPackages());setDraft(null);setNotice('工作包已保存。');
    });}}>
      <h4>{draft.revision?'编辑工作包':'新建工作包'}</h4>
      <label>项目<select aria-label="工作包项目" className="input-field" required disabled={!!draft.revision||busy} value={draft.project} onChange={e=>setDraft({...draft,project:e.target.value})}><option value="">选择已连接目录</option>{snapshot?.projects.map(p=><option key={p.path} value={p.path}>{p.path}</option>)}</select></label>
      <label>工作包名称<input aria-label="工作包名称" className="input-field" required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} placeholder="例如：软著申请"/></label>
      <label>交付目标<textarea aria-label="交付目标" className="input-field" rows={2} maxLength={1000} value={draft.goal} onChange={e=>setDraft({...draft,goal:e.target.value})} placeholder="交付内容与验收标准"/></label>
      {draft.nodes.map((n,i)=><fieldset className="cockpit-node-editor" key={n.id}><legend>节点 {i+1}</legend>
        <label>节点名称<input aria-label={`节点 ${i+1} 名称`} className="input-field" required maxLength={120} value={n.title} onChange={e=>updateNode(n.id,{title:e.target.value})}/></label>
        <div className="cockpit-fields"><label>状态<select aria-label={`节点 ${i+1} 状态`} className="input-field" value={n.status} onChange={e=>updateNode(n.id,{status:e.target.value as typeof n.status})}>{Object.entries(NODE_LABELS).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label>
        <label>目标日期<input aria-label={`节点 ${i+1} 目标日期`} type="date" className="input-field" value={n.dueDate} onChange={e=>updateNode(n.id,{dueDate:e.target.value})}/></label></div>
        <label>下一步<input aria-label={`节点 ${i+1} 下一步`} className="input-field" maxLength={1000} value={n.nextStep} onChange={e=>updateNode(n.id,{nextStep:e.target.value})}/></label>
        <label>阻塞原因<input aria-label={`节点 ${i+1} 阻塞原因`} className="input-field" maxLength={1000} value={n.blocker} onChange={e=>updateNode(n.id,{blocker:e.target.value})} placeholder="选填"/></label>
        {draft.nodes.length>1&&<details><summary>前置节点（{n.dependsOn.length}）</summary>{draft.nodes.filter(d=>d.id!==n.id).map(d=><label className="check-setting" key={d.id}><input type="checkbox" checked={n.dependsOn.includes(d.id)} onChange={e=>updateNode(n.id,{dependsOn:e.target.checked?[...n.dependsOn,d.id]:n.dependsOn.filter(id=>id!==d.id)})}/>{d.title||'未命名节点'}</label>)}</details>}
      </fieldset>)}
      <button className="text-button" type="button" disabled={draft.nodes.length>=60||busy} onClick={()=>setDraft({...draft,nodes:[...draft.nodes,newNode()]})}>＋ 添加节点</button>
      <SourceEditor draft={draft} onChange={setDraft}/>
      <div className="cockpit-actions"><button type="submit" className="btn-primary" disabled={busy||!isTauri()}>{busy?'保存中…':'保存'}</button><button type="button" className="text-button" disabled={busy} onClick={()=>setDraft(null)}>取消</button></div>
    </form> : <>
      <div className="pm-work-heading"><h4>已连接仓库</h4><button className="text-button" disabled={busy} onClick={()=>void action(refresh)}>刷新</button></div>
      {snapshot?.projects.map(p=><article className="cockpit-project" key={p.path}>
        <strong>{p.path.split(/[\\/]/).at(-1)}</strong><small className="cockpit-path">{p.path}</small>
        <p className="muted-copy">更新于 {time(p.observedAt)}</p>
        {p.error?<p className="inline-notice">{p.error}</p>:p.kind==='reference'?<p className="muted-copy">{p.notice}</p>:<>
          <p>{p.git?.branch} · {p.git?.head.slice(0,8)||'尚无提交'}</p>
          <p>{p.git?.dirty?`暂存 ${p.git.staged} · 修改 ${p.git.modified} · 未跟踪 ${p.git.untracked}`:'工作区干净'}{p.git?.conflicts?` · ${p.git.conflicts} 个冲突`:''}</p>
          {p.git?.consistent===false&&<p className="inline-notice">采集期间仓库状态发生变化，请刷新。</p>}
          {!!p.git?.files.length&&<details><summary>变更文件</summary>{p.git.files.map((f,i)=><div className="cockpit-path" key={i}>{f.status} · {f.path}</div>)}</details>}
          <details className="project-source-status"><summary>数据源状态</summary>{checkSources(p).map(s=><div className="source-row" key={s.name} data-state={s.state}><div><strong>{s.name}</strong><p>{s.detail}</p></div></div>)}</details><h5>构建与测试</h5>
          {p.ci?.release&&<p className="muted-copy">最近发布：<a href={p.ci.release.url} target="_blank" rel="noreferrer">{p.ci.release.tagName} · {p.ci.release.assets.length} 个文件</a></p>}
          {p.ci?.observedAt&&<small>GitHub 同步：{time(p.ci.observedAt)}</small>}
          {[...(p.ci?.runs||[]).slice(0,1),...(p.localChecks?.runs||[]).slice(0,1)].map((r,i)=><CheckRow run={r} project={p} key={i}/>)}
          {((p.ci?.runs?.length||0)>1||(p.localChecks?.runs?.length||0)>1)&&<details><summary>历史构建与测试</summary>{[...(p.ci?.runs||[]).slice(1),...(p.localChecks?.runs||[]).slice(1)].map((r,i)=><CheckRow run={r} project={p} key={i}/>)}</details>}
          {(p.ci?.error||p.ci?.notice)&&<p className="muted-copy">{p.ci.error||p.ci.notice}</p>}
          {(p.localChecks?.error||p.localChecks?.notice)&&<p className="muted-copy">{p.localChecks.error||p.localChecks.notice}</p>}
        </>}
      </article>)}
      {!engineeringError&&!snapshot?.projects.length&&<p className="muted-copy">暂未连接本地仓库或文件夹。</p>}
      {snapshot?.truncated&&<p className="inline-notice">已连接超过 12 个目录，仅展示前 12 个。</p>}
      <details className="cockpit-connect" open={!snapshot?.projects.length}><summary>添加本地项目目录</summary><form onSubmit={e=>{e.preventDefault();void action(async()=>{await invoke('pm_add_directory',{path:directory});setDirectory('');await refresh();setNotice('目录已添加。');});}}>
        <input aria-label="项目目录" className="input-field" required value={directory} onChange={e=>setDirectory(e.target.value)} placeholder="粘贴本地项目文件夹路径"/><button type="submit" className="text-button" disabled={busy||!isTauri()}>添加</button>
      </form></details>
      <div className="pm-work-heading"><h4>工作包与节点</h4><button className="text-button" disabled={!snapshot?.projects.length||busy} onClick={()=>edit({id:crypto.randomUUID(),project:snapshot?.projects[0]?.path||'',title:'',goal:'',revision:0,nodes:[newNode()]})}>＋ 新建工作包</button></div>
      {!packagesError&&!packages.length&&<p className="muted-copy">暂无工作包。</p>}
      {packages.map(p=><article className="cockpit-package" key={p.id}>
        <div className="pm-work-heading"><strong>{p.title}</strong><button className="text-button" disabled={busy} onClick={()=>edit(p)}>编辑</button></div>
        <small>{p.project.split(/[\\/]/).at(-1)} · 已完成 {p.nodes.filter(n=>n.status==='done').length}/{p.nodes.length} · {time(p.updatedAt)}</small>
        <p>{p.goal}</p>
        {p.nodes.map(n=><div className="cockpit-node" key={n.id}><strong>{n.title}</strong><small>{NODE_LABELS[n.status]}{n.dueDate?` · 目标 ${n.dueDate}`:''}</small>
          {n.nextStep&&<p>下一步：{n.nextStep}</p>}{n.blocker&&<p>阻塞：{n.blocker}</p>}
          {!!n.dependsOn.length&&<small>依赖：{n.dependsOn.map(id=>p.nodes.find(x=>x.id===id)?.title||id).join('、')}</small>}
        </div>)}
        <WorkSources pack={p}/>
        <p className="muted-copy">可推进：{readyNodes(p).map(n=>n.title).join('、')||'无'}</p>
        <button className="text-button" disabled={busy} onClick={()=>void action(async()=>setHistory({title:p.title,rows:await workTimeline(p.id)}))}>修订记录</button>
      </article>)}
      <details><summary>Codex 运行记录</summary>{codexError&&<p className="inline-notice">{codexError}</p>}{codex?.tasks.map(t=><div className="pm-task" key={t.id}><strong>{t.title}</strong><small>{TASK_LABELS[t.status]||'未知'} · {time(t.updatedAt)}{t.stale?' · 较早记录':''}</small>{t.progress&&<p>{t.progress}</p>}</div>)}</details>
      {history&&<section className="cockpit-timeline"><div className="pm-work-heading"><h4>{history.title} · 修订记录</h4><button className="text-button" onClick={()=>setHistory(null)}>收起</button></div>
        {history.rows.map(r=><details key={r.revision}><summary>{time(r.created)} · v{r.revision}</summary><p>{r.package.goal}</p>{r.package.nodes.map(n=><p key={n.id}>{n.title} · {NODE_LABELS[n.status]}{n.nextStep?` · 下一步：${n.nextStep}`:''}{n.blocker?` · 阻塞：${n.blocker}`:''}</p>)}<small>{r.source}</small></details>)}
      </section>}
    </>}
  </div>;
}
