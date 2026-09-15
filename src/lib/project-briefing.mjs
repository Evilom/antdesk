import {readyNodes,NODE_LABELS,resultLabel,evidenceLabel} from './cockpit-data.mjs';
export function projectEventState(snapshot,packages) {
  const entries=[];
  for(const p of snapshot?.projects||[]) {
    if(p.error)continue;
    if(p.git?.head)entries.push([`head:${p.path}`,p.git.head]);
    for(const r of [...(p.ci?.runs||[]),...(p.localChecks?.runs||[])]) {
      const id=r.databaseId||r.id;
      if(id && ['completed','passed','failed'].includes(r.status))entries.push([`check:${p.path}:${id}`,r.conclusion||r.status]);
    }
  }
  for(const p of packages)entries.push([`package:${p.id}`,String(p.revision)]);
  return Object.fromEntries(entries);
}
export function changedProjectEvents(previous,next) {
  if(!previous)return [];
  return Object.keys(next).filter(key=>next[key]!==previous[key]);
}
export function dailyBriefingKey(now,time) {
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))return '';
  const minutes=now.getHours()*60+now.getMinutes();
  const [h,m]=time.split(':').map(Number),delay=minutes-h*60-m;
  if(delay<0||delay>30)return '';
  return `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}:${time}`;
}
export function buildProjectBriefing(snapshot,packages,reason='项目进度') {
  const lines=[`${reason} · ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`];
  if(!snapshot?.projects.length)lines.push('尚未连接工程，暂无可验证的 Git 或构建状态。');
  for(const p of (snapshot?.projects||[]).slice(0,3)) {
    const name=p.path.split(/[\\/]/).at(-1);
    if(p.error){lines.push(`${name}：采集失败，当前状态未确认。`);continue;}
    if(!p.git){lines.push(`${name}：参考文件夹已连接。`);continue;}
    lines.push(`${name}：${p.git.head?.slice(0,8)||'尚无提交'}；${p.git.dirty?'有未提交改动':'工作区干净'}。`);
    const run=p.ci?.runs?.[0]||p.localChecks?.runs?.[0];
    lines.push(run?`最近检查：${resultLabel(run)}，${evidenceLabel(run,p)}。`:'构建 / 测试尚无记录，不能确认通过。');
  }
  if(!packages.length)lines.push('尚未登记工作包，不从历史聊天推断完成情况。');
  for(const p of packages.slice(0,3)) {
    const current=p.nodes.find(n=>n.status==='doing')||p.nodes.find(n=>n.status==='blocked');
    const next=readyNodes(p)[0];
    lines.push(`${p.title}：${current?`${current.title}（${NODE_LABELS[current.status]}）`:`完成 ${p.nodes.filter(n=>n.status==='done').length}/${p.nodes.length} 个登记节点`}。`);
    const blocked=p.nodes.find(n=>n.blocker||n.status==='blocked');
    if(blocked)lines.push(`阻塞：${blocked.title}，${blocked.blocker||'原因未登记'}。`);
    lines.push(next?`下一步：${next.title}${next.nextStep?`，${next.nextStep}`:''}。`:'下一步：检查前置依赖、阻塞或验收结果。');
  }
  return lines.join('\n');
}
