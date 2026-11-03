import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPmoReviewDraft, appendPreparedDraft } from '../src/lib/pmo-review.mjs';

test('review drafts include scope and evidence but do not leak arbitrary private fields', () => {
  const payload = {dailyMinutes:240,pmo:{projects:[{id:'pmo:pm',name:'湃特蒙',role:'main',priority:'P0',scopeFrozen:true,goal:'交付首发',definitionOfDone:'真机通过',weeklyBudgetMinutes:1920}]}};
  const text=buildPmoReviewDraft(payload,[{id:'local:1',title:'验收新手',projectId:'pmo:pm',scope:'committed',verification:'needs_check',acceptanceCriteria:'录像无卡点',apiKey:'secret',privateMessages:'DM secret'},{id:'local:2',title:'其他项目',projectId:'pmo:other'}],'pmo:pm');
  assert.match(text,/湃特蒙/);assert.match(text,/待核实/);assert.match(text,/录像无卡点/);assert.match(text,/只评审/);
  assert.doesNotMatch(text,/DM secret|apiKey|其他项目/);
});

test('large review snapshots stay within native UTF-8 limit and report omissions',()=>{
  const tasks=Array.from({length:300},(_,i)=>({id:`local:${i}`,title:'事项'.repeat(100),description:'证据'.repeat(500),acceptanceCriteria:'验收'.repeat(300)}));
  const text=buildPmoReviewDraft({pmo:{projects:[]}},tasks);
  assert.ok(Buffer.byteLength(text)<32000);assert.match(text,/未包含/);
});

test('a review works for a single webpage assistant without claiming absent peers or tools',()=>{
  const text=buildPmoReviewDraft({pmo:{projects:[]}},[]);
  assert.match(text,/没有这些工具时直接返回文字建议/);
  assert.match(text,/不要代替未参与的助理发言/);
  assert.match(text,/不修改 Notion 页面/);
  assert.doesNotMatch(text,/Muse 负责|Grok 负责|omdot 负责/);
});

test('preparing a review preserves existing room drafts and rejects oversize append without truncation',()=>{
  assert.deepEqual(appendPreparedDraft('我的草稿','评审'),{text:'我的草稿\n\n评审',appended:true,error:''});
  const old='中'.repeat(10666);const result=appendPreparedDraft(old,'新评审');
  assert.equal(result.text,old);assert.equal(result.appended,false);assert.match(result.error,/原草稿/);
});
test('a realistic project review includes all task titles and follows the actual chosen main project',()=>{
  const tasks=Array.from({length:45},(_,i)=>({id:`local:release-${i}`,title:`交付核验${i}`,projectId:'pmo:next',estimateMinutes:120,scope:'committed',acceptanceCriteria:'完成定义'.repeat(60)}));
  const text=buildPmoReviewDraft({pmo:{projects:[{id:'pmo:next',name:'当前新主线',role:'main'}]}},tasks,'pmo:next');
  assert.match(text,/当前主线为 当前新主线/);assert.match(text,/交付核验44/);assert.ok(Buffer.byteLength(text)<32000);
});
