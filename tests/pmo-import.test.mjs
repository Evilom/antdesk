import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const seed=JSON.parse(fs.readFileSync(path.join(root,'data/pmo-backlog-20261103.json'),'utf8'));

test('portfolio import previews, backs up, preserves existing data and is idempotent with revision conflicts',t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-pmo-import-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const database=path.join(temp,'pm.sqlite3');
  const db=new DatabaseSync(database);
  db.exec('CREATE TABLE planner_state(singleton INTEGER PRIMARY KEY,revision INTEGER,payload TEXT);CREATE TABLE other_data(value TEXT);INSERT INTO other_data VALUES (\'untouched\')');
  const demo={id:'local:preview-edge-20261102-1',title:'测试 · 钢琴栏',state:'ready',priority:'medium'};
  const personal={id:'local:existing-user',title:'原有个人事项',state:'waiting',priority:'high',description:'must survive'};
  const initial={schemaVersion:1,localTasks:[demo,personal],overrides:{'local:existing-user':{waitingReason:'原有等待原因'}},order:[personal.id,demo.id],focusId:null,dailyMinutes:180,history:[]};
  db.prepare('INSERT INTO planner_state VALUES(1,7,?)').run(JSON.stringify(initial));
  const read=()=>{const row=db.prepare('SELECT * FROM planner_state').get();return {revision:row.revision,payload:JSON.parse(row.payload)};};
  const run=(...args)=>spawnSync(process.execPath,[path.join(root,'scripts/import-pmo-backlog.mjs'),...args],{encoding:'utf8',env:{...process.env,ANTDESK_PMO_DATABASE:database,ANTDESK_PMO_BACKUP_ROOT:path.join(temp,'backups')}});
  try{
    const preview=run();assert.equal(preview.status,0,preview.stderr);assert.equal(read().revision,7);
    const conflict=run('--apply','--revision=6');assert.notEqual(conflict.status,0);assert.equal(read().revision,7);
    const applied=run('--apply','--revision=7');assert.equal(applied.status,0,applied.stderr);
    const first=read();assert.equal(first.revision,8);assert.equal(first.payload.dailyMinutes,180);
    assert.equal(first.payload.localTasks.length,seed.tasks.length+2);
    assert.equal(first.payload.localTasks.find(t=>t.id===personal.id).description,'must survive');
    assert.equal(first.payload.overrides[personal.id].waitingReason,'原有等待原因');
    assert.equal(first.payload.overrides[demo.id].archived,true);
    assert.equal(first.payload.history.at(-1).before.localTasks.length,2);
    assert.equal(db.prepare('SELECT value FROM other_data').get().value,'untouched');
    const result=JSON.parse(applied.stdout);assert.ok(fs.existsSync(path.join(result.backupDir,'planner-before.json')));
    const repeated=run('--apply','--revision=8');assert.equal(repeated.status,0,repeated.stderr);assert.equal(JSON.parse(repeated.stdout).changed,false);
    assert.deepEqual(read(),first);
    const seedId=seed.tasks[0].id;first.payload.overrides[seedId]={evidence:'已由用户补充的真实证据'};
    db.prepare('UPDATE planner_state SET revision=9,payload=?').run(JSON.stringify(first.payload));
    const keepEdit=run('--apply','--revision=9');assert.equal(keepEdit.status,0,keepEdit.stderr);
    assert.equal(read().revision,9);assert.equal(read().payload.overrides[seedId].evidence,'已由用户补充的真实证据');
  }finally{db.close();}
});
