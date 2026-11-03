const clean = (value, limit = 600) => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, limit).trim() : '';
const bytes = value => new TextEncoder().encode(value).length;
const stage = task => task.stage || task.state;
const roleNames = { main: '核心主线', support: '辅助项目', paused: '已暂停' };
const scopeNames = { committed: '本期计划', candidate: '待规划', later: '暂缓储备' };

/** A reviewable draft only. It contains an explicit field allowlist and never
 * reads assistant messages, credentials or unrelated private conversations. */
export function buildPmoReviewDraft(payload, tasks = [], projectId) {
  const pmo = payload?.pmo || {};
  const projects = Array.isArray(pmo.projects) ? pmo.projects : [];
  const project = projects.find(item => item.id === projectId);
  const main = projects.find(item => item.role === 'main');
  const selected = tasks.filter(task => (!projectId || task.projectId === projectId) && !['done', 'archived'].includes(stage(task)));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const parts = [
    `请对${project ? `「${clean(project.name, 100)}」` : '当前项目与本周待办'}进行评审。以下为本机当前状态快照，实际执行前请核对状态。`,
    `核心原则：当前主线为 ${clean(main?.name, 100) || '尚未确定'}，同期最多 1 个主线和 2 个辅助项目。新想法先进入待规划列表；已锁定的计划范围必须提出有理由的变更建议。任务要有完成定义、预算、依赖与交付证据。尚未核实的历史反馈不等于当前缺陷。`,
    '这次只评审并返回建议：不开始开发、不替用户完成事项、不修改 Notion 页面、不扩大范围、不创建新项目。若当前连接提供 AntDesk 的 list_priority_queue 与 reorder_priority_queue，可读取最新版本并提交待采纳排序建议；没有这些工具时直接返回文字建议，不声称已读取或修改本机状态。最终取舍由用户在 AntDesk 确认。',
    '请从三个视角评审：需求拆分与依赖；反证、风险与缺失证据；交付范围、优先级和停止条件。每位实际收到本次请求的助理独立判断；若上下文包含其他助理的意见，明确分歧与依据。不要代替未参与的助理发言，也不自动互相派发新任务。',
    '输出格式：①结论（可推进/需修改/阻塞）；②本期建议优先处理的 1~3 项核心待办，引用事项 ID、理由与预算；③应暂停或移出的事项；④需要补的证据；⑤如需扩范围，说明新增成本及替换掉哪项本期计划。区分已经做出来、质量已验收、具备发布条件三个阶段。',
    `本周个人时间容量：${Number(pmo.weeklyCapacityMinutes) || 2400} 分钟；每日安排容量：${Number(payload?.dailyMinutes) || 240} 分钟。估时是规划预算，不是已验证工时。`,
    '【项目概况】',
  ];
  let projectCount=0;
  for(const item of projects){
    const detailed=!projectId||item.id===projectId;
    const entry=`${clean(item.name, 100)}｜${item.priority || '未定级'}｜${roleNames[item.role] || '未归类'}｜每周 ${Number(item.weeklyBudgetMinutes) || 0} 分钟｜${item.scopeFrozen ? '计划已锁定' : '范围待锁定'}${detailed?'\n阶段目标：'+(clean(item.goal,240)||'待明确')+'\n交付标准(DoD)：'+(clean(item.definitionOfDone,400)||'待明确'):''}`;
    if(bytes([...parts,entry].join('\n\n'))>9000)break;
    parts.push(entry);projectCount++;
  }
  if(projectCount<projects.length)parts.push(`另有 ${projects.length-projectCount} 个项目约束未包含，需另行读取。`);
  parts.push(`【待办列表】共 ${selected.length} 项${project ? '（仅本项目）' : ''}：`);
  let indexed=0;
  for(const task of selected){
    const entry=`${clean(task.id,180)}｜${clean(task.title,120)}｜${task.pmoPriority||task.priority||'未定级'} · ${scopeNames[task.scope]||'候选'} · ${Number(task.estimateMinutes)||0} 分钟 · ${task.verification==='confirmed'?'现状有依据':'待核实'}`;
    if(bytes([...parts,entry].join('\n\n'))>17000)break;
    parts.push(entry);indexed++;
  }
  if(indexed<selected.length)parts.push(`另有 ${selected.length-indexed} 项索引未包含，请拆分评审。`);
  parts.push('【优先事项详情】');
  let included = 0;
  for (const task of selected) {
    const dependencies = (Array.isArray(task.dependencies) ? task.dependencies : []).map(id => `${clean(id, 160)} ${clean(byId.get(id)?.title, 80) || '未载入'}`).join('；');
    const sources = (Array.isArray(task.sourceRefs) ? task.sourceRefs : []).slice(0, 3).map(value => clean(value, 220)).join('；');
    const entry = `${clean(task.id, 180)}｜${clean(task.title, 240)}\n${task.pmoPriority || task.priority || '未定级'} · ${clean(task.projectName, 100) || clean(task.projectId, 100) || '未归类'} · ${stage(task) || '待整理'} · ${scopeNames[task.scope] || '待规划'} · ${Number(task.estimateMinutes) || 0} 分钟 · ${task.verification === 'confirmed' ? '已核实' : '待核实'}\n验收标准 (DoD)：${clean(task.acceptanceCriteria, 480) || '尚未补齐'}\n完成凭证：${clean(task.evidence, 300) || '暂无凭证'}${task.description ? '\n说明：' + clean(task.description, 420) : ''}${dependencies ? '\n前置：' + dependencies : ''}${sources ? '\n来源：' + sources : ''}`;
    // Native chat permits 32KB of UTF-8. Leave room for the user's edits.
    if (bytes([...parts, entry].join('\n\n')) > 27000) break;
    parts.push(entry); included++;
  }
  if (included < selected.length) parts.push(`本条展开前 ${included}/${selected.length} 项详情；其余 ${selected.length - included} 项建议按项目分批核对。`);
  if (!selected.length) parts.push('此范围当前没有未完成事项。请核对项目目标与完成证据，不要凭空生成开发任务。');
  return parts.join('\n\n');
}

export function appendPreparedDraft(previous, next, limit = 32000) {
  const original = typeof previous === 'string' ? previous : '';
  const addition = typeof next === 'string' ? next : '';
  if (!addition.trim()) return { text: original, appended: false, error: '评审草稿为空。' };
  const text = original.trim() ? original + '\n\n' + addition : addition;
  if (bytes(text) > limit) return { text: original, appended: false, error: '当前聊天已有较长草稿，无法追加评审。请先保存或发送原草稿，再重新准备评审。' };
  return { text, appended: true, error: '' };
}
