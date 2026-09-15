import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSources,checkSources} from '../src/lib/source-status.mjs';
import {projectEventState,changedProjectEvents,dailyBriefingKey,buildProjectBriefing} from '../src/lib/project-briefing.mjs';
import {validateVersions} from '../scripts/release-version.mjs';
test('unconnected, inaccessible and stale sources never report healthy',()=>{
  assert.equal(projectSources(null).state,'unknown');
  assert.equal(projectSources({observedAt:100,projects:[]},'',100).state,'empty');
  assert.equal(projectSources({observedAt:100,projects:[{path:'/project',error:'denied'}]},'',100).state,'error');
  assert.equal(projectSources({observedAt:100,projects:[{path:'/project',git:{head:'abc'}}]},'',146).state,'stale');
  assert.equal(projectSources({observedAt:100,projects:[]},'connection failed',100).state,'error');
  assert.equal(checkSources({ci:{error:'not logged in'},localChecks:{runs:[]}})[1].state,'error');
  assert.equal(checkSources({ci:{runs:[]},localChecks:{runs:[]}})[2].state,'empty');
});
test('briefings establish a baseline and detect new commits, check outcomes and node revisions',()=>{
  const first=projectEventState({projects:[{path:'/p',git:{head:'a'}}]},[{id:'p',revision:1}]);
  assert.deepEqual(changedProjectEvents(null,first),[]);
  assert.deepEqual(changedProjectEvents(first,first),[]);
  const next=projectEventState({projects:[{path:'/p',git:{head:'b'},ci:{runs:[{databaseId:2,status:'completed',conclusion:'failure'}]}}]},[{id:'p',revision:2}]);
  assert.equal(changedProjectEvents(first,next).length,3);
});
test('daily briefings honor local time, dedupe keys and missed-window limit',()=>{
  assert.equal(dailyBriefingKey(new Date(2026,8,15,8,59),'09:00'),'');
  assert.equal(dailyBriefingKey(new Date(2026,8,15,9,10),'09:00'),'2026-9-15:09:00');
  assert.equal(dailyBriefingKey(new Date(2026,8,15,9,31),'09:00'),'');
  assert.equal(dailyBriefingKey(new Date(),''),'');
});
test('briefing states missing evidence and respects blocked dependencies',()=>{
  const text=buildProjectBriefing(null,[{title:'软著',nodes:[{id:'a',title:'材料',status:'blocked',blocker:'待确认',dependsOn:[]},{id:'b',title:'提交',status:'todo',blocker:'',dependsOn:['a']}]}]);
  assert.match(text,/尚未连接工程/);assert.match(text,/待确认/);assert.doesNotMatch(text,/下一步：提交/);
});
test('release rejects inconsistent manifests and a tag pointing at another version',()=>{
  const valid={app:'2.19.2',frontend:'2.19.2',rust:'2.19.2',lock:'2.19.2'};
  assert.equal(validateVersions(valid,'v2.19.2'),'2.19.2');
  assert.throws(()=>validateVersions({...valid,rust:'2.5.2'}));
  assert.throws(()=>validateVersions(valid,'v2.19.1'));
});
