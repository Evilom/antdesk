export function projectSources(snapshot, error='', now=Date.now()/1000) {
  if(error)return {state:'error',label:'读取失败',detail:error};
  if(!snapshot)return {state:'unknown',label:'尚未检查',detail:'正在读取本机已连接目录'};
  const rows=snapshot.projects||[];
  if(now-snapshot.observedAt>45)return {state:'stale',label:'数据已过期',detail:'显示上次采集结果，请刷新后判断进度'};
  if(!rows.length)return {state:'empty',label:'未连接项目',detail:'选择本设备目录后才可读取 Git 与文档'};
  const bad=rows.filter(p=>p.error||p.git?.consistent===false).length;
  return {state:bad?'error':'ready',label:bad?`${bad} 个目录需处理`:`${rows.length} 个目录已连接`,detail:rows.map(p=>`${p.path.split(/[\\/]/).at(-1)}${p.error?'：不可访问':p.git?'：Git 可读':'：参考文件夹'}`).join(' · ')};
}
export function checkSources(project) {
  return [
    {name:'Git',state:project.error?'error':project.git?'ready':'empty',detail:project.error||(project.git?`提交 ${project.git.head?.slice(0,8)||'尚未提交'}`:'参考文件夹，无 Git 状态')},
    {name:'GitHub CI',state:project.ci?.error?'error':project.ci?.runs?.length?'ready':'empty',detail:project.ci?.error||project.ci?.notice||(project.ci?.runs?.length?`${project.ci.runs.length} 条运行记录；通过不代表已上传安装包`:'尚无构建记录')},
    {name:'本机构建 / 测试',state:project.localChecks?.error?'error':project.localChecks?.runs?.length?'ready':'empty',detail:project.localChecks?.error||project.localChecks?.notice||(project.localChecks?.runs?.length?'已接入检查记录':'尚未接入记录器，不能知道终端命令结果')},
  ];
}
