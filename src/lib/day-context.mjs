const clip=(value,n)=>{const s=String(value??'');return s.length>n?s.slice(0,n)+'…':s;};
const labels={user:'大师说过',assistant:'助理历史回答，未验证',project:'项目采集'};
export function formatDayContext(day,budget=2800) {
  const entries=[...day.messages,...day.observations].sort((a,b)=>a.created-b.created);
  const header=`过去24小时 · 当前对话（跨午夜继续，不自动新建）\n${day.scope}\n${new Date(day.since*1000).toLocaleString('zh-CN')} — ${new Date(day.observedAt*1000).toLocaleString('zh-CN')}；对话${day.messageCount}条，项目采集${day.observationCount}条。以下是节选，遗漏不代表没做；具体问题按关键词再检索。\n`;
  const selected=new Map();let length=header.length+60;
  const add=e=>{
    if(!e||selected.has(e.id))return;
    const line=`${new Date(e.created*1000).toLocaleString('zh-CN')} [${labels[e.kind]||e.kind}] ${clip(e.text.replace(/\s+/g,' '),e.matched?240:150)}`;
    if(length+line.length+1<=budget){selected.set(e.id,{...e,line});length+=line.length+1;}
  };
  entries.filter(e=>e.matched).sort((a,b)=>(a.kind==='user'?-1:0)-(b.kind==='user'?-1:0)||b.created-a.created).forEach(add);
  entries.slice(-3).forEach(add);
  // Sample across the whole day before filling nearby turns; morning survives long calls.
  for(let i=0;i<=12;i++)add(entries[Math.floor((entries.length-1)*i/12)]);
  entries.forEach(add);
  return `${header}${[...selected.values()].sort((a,b)=>a.created-b.created).map(e=>e.line).join('\n')}\n本次提供${selected.size}条节选。历史回答不能作为完成工作或执行操作的证据。`.slice(0,budget);
}
async function observation(source,value,text) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return {source,fingerprint:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),text:clip(text,1700)};
}
/** Record only already connected sources. A polling timestamp is not a state change. */
export async function projectObservations(feed) {
  const result=[];
  if(!feed.engineeringError) for(const p of feed.snapshot?.projects||[]) {
    const name=p.path.split(/[\\/]/).at(-1)||p.path;
    if(p.error){result.push(observation(`git:${p.path}`,{error:p.error},`${name} · 来源 ${p.path}：采集失败 ${p.error}`));continue;}
    const g=p.git;
    if(g) {
      const files=[...(g.files||[])].sort((a,b)=>a.path.localeCompare(b.path));
      const fact={...g,files};
      result.push(observation(`git:${p.path}`,fact,`${name} · 来源 ${p.path}：分支 ${g.branch}，提交 ${g.head}；采集到${g.dirty?'有未提交改动':'工作区干净'}，暂存 ${g.staged}、修改 ${g.modified}、未跟踪 ${g.untracked}、冲突 ${g.conflicts}；快照${g.consistent?'一致':'可能正在变化'}。${files.slice(0,8).map(f=>`${f.status} ${f.path}`).join('；')}`));
    }
    for(const [kind,data] of [['CI',p.ci],['本地检查',p.localChecks]]) {
      if(!data)continue;
      const runs=(data.runs||[]).map(r=>({id:r.databaseId??r.id,head:r.headSha??r.head,status:r.status,conclusion:r.conclusion,clean:r.clean,label:r.label??r.workflowName}));
      const value={runs,error:data.error||'',release:data.release?.tagName||''};
      result.push(observation(`${kind}:${p.path}`,value,`${name} · ${kind}采集，来源 ${p.path}：${data.error||runs.map(r=>`${r.label||r.id} ${r.status}/${r.conclusion||'待确认'}，提交 ${r.head||'未知'}${r.clean===false?'（含未提交改动）':''}`).join('；')||'没有检查记录'}${data.release?`；发布 ${data.release.tagName}`:''}`));
    }
  }
  if(!feed.packagesError) for(const p of feed.packages||[]) {
    result.push(observation(`package:${p.id}`,{revision:p.revision,nodes:p.nodes},`工作包 ${p.title} · 来源 ${p.project} · 修订 ${p.revision}（登记状态不等于代码验收）：${p.nodes.map(n=>`${n.title}=${n.status}${n.blocker?`，阻塞 ${n.blocker}`:''}${n.nextStep?`，下一步 ${n.nextStep}`:''}`).join('；')}`));
  }
  return Promise.all(result);
}
