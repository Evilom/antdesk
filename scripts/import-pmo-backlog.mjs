// One-time, idempotent portfolio import. Run with the app closed. Preview is
// the default; --apply requires an explicit current revision to prevent races.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {normalizePlanner,applyPlannerChange,buildPlan} from '../src/lib/planner-model.mjs';
import {projectPolicyIssue} from '../src/lib/pmo-model.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2),apply=args.includes('--apply');
const revisionArg=args.find(value=>value.startsWith('--revision='));
const expected=revisionArg?Number(revisionArg.slice('--revision='.length)):null;
if(apply&&(!Number.isSafeInteger(expected)||expected<0))throw Error('--apply requires --revision=<current revision>');
const database=process.env.ANTDESK_PMO_DATABASE||path.join(process.env.APPDATA||'', 'com.antdesk.app/assistant/pm.sqlite3');
if(!path.isAbsolute(database)||!fs.existsSync(database))throw Error('Existing AntDesk database was not found');
const seed=JSON.parse(fs.readFileSync(path.join(root,'data/pmo-backlog-20261103.json'),'utf8'));
const candidate=normalizePlanner({schemaVersion:1,localTasks:seed.tasks,overrides:{},order:seed.tasks.map(t=>t.id),dailyMinutes:240,pmo:seed.pmo});
if(candidate.localTasks.length!==seed.tasks.length)throw Error('Seed contains duplicate or invalid task IDs');
const seedIds=new Set(candidate.localTasks.map(t=>t.id));
for(const task of candidate.localTasks){
  if(!task.acceptanceCriteria?.trim()||!task.estimateMinutes||!task.sourceRefs?.length)throw Error('Seed lacks task criteria, budget or source: '+task.id);
  if((task.dependencies||[]).some(id=>!seedIds.has(id)))throw Error('Seed dependency does not exist: '+task.id);
}
const seedIssue=projectPolicyIssue(candidate.pmo);if(seedIssue)throw Error(seedIssue);
const db=new DatabaseSync(database,{readOnly:!apply});
db.exec('PRAGMA busy_timeout=5000');
let committed=false;
try {
  if(apply)db.exec('BEGIN IMMEDIATE');
  const row=db.prepare('SELECT revision,payload FROM planner_state WHERE singleton=1').get();
  if(!row)throw Error('Existing planner snapshot was not found');
  if(apply&&row.revision!==expected)throw Error(`TASK_HUB_CONFLICT: expected ${expected}; current ${row.revision}`);
  const original=JSON.parse(row.payload),current=normalizePlanner(original);
  const existing=new Set(current.localTasks.map(t=>t.id));
  const adding=candidate.localTasks.filter(t=>!existing.has(t.id));
  const demoIds=current.localTasks.filter(t=>/^local:preview-edge-20261102-[1-7]$/.test(t.id)&&t.title.startsWith('测试')).map(t=>t.id);
  const next=applyPlannerChange(current,'导入项目交付待办，归档演示事项',draft=>{
    draft.localTasks.push(...adding);
    for(const id of demoIds)draft.overrides[id]={...draft.overrides[id],archived:true,state:'archived'};
    if(demoIds.includes(draft.focusId))draft.focusId=null;
    if(!draft.pmo.enabled)draft.pmo=candidate.pmo;
    else for(const project of candidate.pmo.projects)if(!draft.pmo.projects.some(p=>p.id===project.id))draft.pmo.projects.push(project);
    if(adding.length){
      const inserted=new Set(adding.map(t=>t.id));
      draft.order=current.pmo.enabled?[...draft.order,...adding.map(t=>t.id)]:[...candidate.order,...draft.order.filter(id=>!inserted.has(id))];
    }
  });
  const issue=projectPolicyIssue(next.pmo);if(issue)throw Error(issue);
  const plan=buildPlan([],[],next),serialized=JSON.stringify(next);
  if(Buffer.byteLength(serialized)>4*1024*1024)throw Error('Imported snapshot exceeds storage capacity');
  const changed=JSON.stringify(current)!==serialized;
  const summary={applied:false,changed,revisionBefore:row.revision,revisionAfter:row.revision,
    added:adding.length,totalLocalTasks:next.localTasks.length,archivedDemonstrations:demoIds.length,
    projects:next.pmo.projects.length,main:plan.portfolio.main?.name,supports:plan.portfolio.supports.map(p=>p.name),
    weeklyCapacityMinutes:next.pmo.weeklyCapacityMinutes,dailyMinutes:next.dailyMinutes,
    firstActions:plan.dailyFocus.map(t=>({id:t.id,title:t.title,minutes:t.estimateMinutes})),
    needsVerification:plan.all.filter(t=>!t.archived&&t.verification==='needs_check').length};
  if(apply&&changed){
    const backupDir=path.join(process.env.ANTDESK_PMO_BACKUP_ROOT||path.join(root,'.antdesk/backups'),'pmo-'+new Date().toISOString().replace(/[:.]/g,'-'));
    fs.mkdirSync(backupDir,{recursive:true});
    fs.writeFileSync(path.join(backupDir,'planner-before.json'),JSON.stringify({revision:row.revision,payload:original},null,2));
    fs.writeFileSync(path.join(backupDir,'planner-after.json'),JSON.stringify({revision:row.revision+1,payload:next},null,2));
    const result=db.prepare('UPDATE planner_state SET revision=?,payload=? WHERE singleton=1 AND revision=?').run(row.revision+1,serialized,row.revision);
    if(result.changes!==1)throw Error('TASK_HUB_CONFLICT: planner changed during import');
    summary.applied=true;summary.revisionAfter=row.revision+1;summary.backupDir=backupDir;
  }
  if(apply){db.exec('COMMIT');committed=true;}
  console.log(JSON.stringify(summary,null,2));
} finally {
  if(apply&&!committed)try{db.exec('ROLLBACK');}catch{}
  db.close();
}
