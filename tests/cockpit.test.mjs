import test from 'node:test';
import assert from 'node:assert/strict';
import {readyNodes,evidenceLabel,resultLabel,cockpitContext} from '../src/lib/cockpit-data.mjs';
const node=(id,patch={})=>({id,title:id,status:'todo',nextStep:'做下一步',dueDate:'',blocker:'',dependsOn:[],...patch});
const pack={id:'p',title:'软著',project:'/project',goal:'正式提交',revision:1,nodes:[node('材料'),node('提交',{dependsOn:['材料']})]};
test('only ready unblocked nodes are proposed as next actions',()=>{
  assert.deepEqual(readyNodes(pack).map(n=>n.id),['材料']);
  assert.deepEqual(readyNodes({...pack,nodes:[node('材料',{status:'done'}),pack.nodes[1]]}).map(n=>n.id),['提交']);
  assert.equal(readyNodes({...pack,nodes:[node('n',{status:'blocked'})]}).length,0);
  assert.equal(readyNodes({...pack,nodes:[node('n',{blocker:'等待确认'})]}).length,0);
});
test('old green builds and dirty worktrees never verify current edits',()=>{
  const p={git:{head:'new',dirty:false,consistent:true}};
  assert.match(evidenceLabel({headSha:'old',conclusion:'success'},p),/未验证/);
  assert.match(evidenceLabel({headSha:'new'},p),/对应当前提交/);
  assert.match(evidenceLabel({headSha:'new'},{git:{...p.git,dirty:true}}),/未验证当前改动/);
  assert.match(evidenceLabel({head:'new',clean:false},p),/未验证当前改动/);
  assert.equal(resultLabel({status:'completed',conclusion:'failure'}),'失败');
  assert.equal(resultLabel({status:'running'}),'已启动，尚无结束记录');
});
test('fresh package changes are reflected in the same voice context',()=>{
  let v=JSON.parse(cockpitContext({projects:[]},[pack],'软著下一步'));
  assert.deepEqual(v.packages[0].ready,['材料']);
  const changed={...pack,revision:2,nodes:[node('材料',{status:'done'}),pack.nodes[1]]};
  v=JSON.parse(cockpitContext({projects:[]},[changed],'软著下一步'));
  assert.equal(v.packages[0].revision,2);assert.deepEqual(v.packages[0].ready,['提交']);
  assert.match(JSON.parse(cockpitContext(null,[])).packageNotice,/不能从聊天推断/);
});
test('large projects keep structured evidence and relevant nodes within voice budget',()=>{
  const packs=Array.from({length:20},(_,i)=>({...pack,id:String(i),title:i===19?'番薯':'项目'+i,goal:'目'.repeat(1000),nodes:Array.from({length:60},(_,j)=>node('节点'+j,{nextStep:'步'.repeat(1000),blocker:'等'.repeat(1000)}))}));
  const raw=cockpitContext({projects:[]},packs,'番薯');assert.ok(raw.length<3500);
  const v=JSON.parse(raw);assert.equal(v.packages[0].title,'番薯');assert.equal(v.truncated,true);
});

test('long dependency chains and CI fields still fit the injection budget',()=>{
  const long='x'.repeat(1000);
  const p={...pack,project:long,title:long,goal:long,nodes:Array.from({length:60},(_,i)=>node(String(i),{title:long,nextStep:long,blocker:long,dueDate:long,dependsOn:Array.from({length:i},(_,j)=>String(j))}))};
  const run={status:'completed',headSha:long,workflowName:long,url:long,updatedAt:long};
  const facts={projects:[{path:long,git:{head:long,branch:long},ci:{runs:[run,run]},localChecks:{runs:[run,run]}}]};
  const raw=cockpitContext(facts,[p]);assert.ok(raw.length<3500,raw.length);assert.equal(JSON.parse(raw).truncated,true);
});
