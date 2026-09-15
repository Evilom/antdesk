export const NODE_LABELS = {todo:'未开始', doing:'进行中', blocked:'受阻', done:'已完成'};
export function readyNodes(pack) {
  return pack.nodes.filter(n => n.status !== 'done' && n.status !== 'blocked' && !n.blocker.trim()
    && n.dependsOn.every(id => pack.nodes.some(d => d.id === id && d.status === 'done')));
}
export function evidenceLabel(run, project) {
  const head = run.headSha ?? run.head;
  if (!head || !project.git?.head || head !== project.git.head) return '其他提交 · 当前版本未验证';
  if (project.git.consistent === false) return '采集期间提交变化 · 需要刷新';
  if (project.git.dirty || run.clean === false) return '对应已提交代码或当时工作区 · 未验证当前改动';
  return '对应当前提交与干净工作区';
}
export function resultLabel(run) {
  if (run.status === 'running') return '已启动，尚无结束记录';
  if (run.status === 'in_progress' || run.status === 'queued') return '进行中';
  const value=run.conclusion || run.status;
  return ({success:'通过',passed:'通过',failure:'失败',failed:'失败',cancelled:'已取消',timed_out:'超时',skipped:'已跳过',action_required:'需要处理'})[value] || '结果未知';
}
export function cockpitContext(snapshot, packages, query='') {
  const rank=p=>query.toLowerCase().includes(p.title?.toLowerCase() || '\0') ? 2 : query.toLowerCase().includes(p.project?.split(/[\\/]/).at(-1)?.toLowerCase() || '\0') ? 1 : 0;
  const chosen=[...packages].sort((a,b)=>rank(b)-rank(a)).slice(0,3);
  const paths=new Set(chosen.map(p=>p.project));
  const projectRank=p=>Number(paths.has(p.path))+Number(query.toLowerCase().includes(p.path.split(/[\\/]/).at(-1).toLowerCase()))*2;
  const projects=[...(snapshot?.projects || [])].sort((a,b)=>projectRank(b)-projectRank(a)).slice(0,3);
  const data={
    source:'AntDesk 项目事实；用户登记的节点状态不是代码验收结果',
    projects:projects.map(p=>({path:p.path,observedAt:p.observedAt,error:p.error,kind:p.kind,notice:p.notice,
      git:p.git ? {branch:p.git.branch,head:p.git.head,dirty:p.git.dirty,conflicts:p.git.conflicts,staged:p.git.staged,modified:p.git.modified,untracked:p.git.untracked,consistent:p.git.consistent}:undefined,
      ciError:p.ci?.error||p.ci?.notice,ciObservedAt:p.ci?.observedAt,
      checks:[...(p.ci?.runs||[]).slice(0,2),...(p.localChecks?.runs||[]).slice(0,2)].map(r=>({name:r.workflowName||r.label,status:resultLabel(r),scope:evidenceLabel(r,p),head:r.headSha||r.head,at:r.updatedAt||r.completedAt||r.startedAt,source:r.url||r.source})),
      localNotice:p.localChecks?.error||p.localChecks?.notice})),
    packages:chosen.map(p=>({id:p.id,title:p.title,project:p.project,revision:p.revision,goal:p.goal.slice(0,180),updatedAt:p.updatedAt,
      nodes:p.nodes.filter(n=>n.status!=='done').slice(0,6).map(n=>({title:n.title,status:NODE_LABELS[n.status],due:n.dueDate,next:n.nextStep.slice(0,200),blocker:n.blocker.slice(0,140),dependencies:n.dependsOn.slice(0,4).map(id=>p.nodes.find(x=>x.id===id)?.title||id)})),
      ready:readyNodes(p).map(n=>n.title).slice(0,3),done:p.nodes.filter(n=>n.status==='done').length,total:p.nodes.length})),
    notice:!projects.length?'尚未连接工程目录，不能推断工程状态':undefined,
    packageNotice:!packages.length?'尚未登记工作包，不能从聊天推断节点已完成':undefined,
    truncated:!!snapshot?.truncated||packages.length>chosen.length||projects.length<(snapshot?.projects.length||0),
  };
  let stringLimit=240;
  const encode=()=>JSON.stringify(data,(_key,value)=>typeof value==='string'&&value.length>stringLimit?value.slice(0,stringLimit)+'…':value);
  if(encode().length>3400){data.truncated=true;data.projects=data.projects.slice(0,1);data.packages=data.packages.slice(0,1);for(const p of data.packages)p.nodes=p.nodes.slice(0,2);}
  if(encode().length>3400){stringLimit=100;for(const p of data.projects)p.checks=p.checks.slice(0,2);for(const p of data.packages){p.ready=p.ready.slice(0,2);for(const n of p.nodes)n.dependencies=n.dependencies.slice(0,2);}}
  if(encode().length>3400){stringLimit=60;for(const p of data.projects)p.checks=p.checks.slice(0,1);}
  return encode();
}
