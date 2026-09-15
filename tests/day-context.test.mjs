import assert from 'node:assert/strict';
import test from 'node:test';
import {formatDayContext,projectObservations} from '../src/lib/day-context.mjs';

test('daily context keeps morning query matches, recent turns and provenance within the transport budget',()=>{
  const at=1800000000;
  const day={since:at-86400,observedAt:at,messageCount:300,observationCount:0,scope:'未采集的活动未知',observations:[],messages:Array.from({length:300},(_,i)=>({id:String(i),kind:i%2?'assistant':'user',created:at-86000+i*280,matched:i===0,text:i===0?'早上完成番薯工作包':i===299?'现在的新进展':'x'.repeat(1000)}))};
  const text=formatDayContext(day,2200);
  assert.ok(text.length<=2200);assert.match(text,/早上完成番薯工作包/);assert.match(text,/现在的新进展/);assert.match(text,/大师说过/);assert.match(text,/助理历史回答，未验证/);assert.match(text,/遗漏不代表没做/);
});

test('observation fingerprints ignore poll times and file ordering, but track real state changes',async()=>{
  const feed={engineeringError:'',packagesError:'',packages:[],snapshot:{observedAt:1,projects:[{path:'/connected/AntDesk',observedAt:1,git:{branch:'main',head:'abc',dirty:true,consistent:true,staged:0,modified:2,untracked:0,conflicts:0,files:[{path:'a',status:'M'},{path:'b',status:'M'}]},ci:{observedAt:1,runs:[{id:'test',head:'abc',status:'completed',conclusion:'success'}]}}]}};
  const first=await projectObservations(feed);feed.snapshot.observedAt=100;feed.snapshot.projects[0].observedAt=100;feed.snapshot.projects[0].git.files.reverse();feed.snapshot.projects[0].ci.observedAt=100;
  assert.deepEqual(await projectObservations(feed),first);
  feed.snapshot.projects[0].git.head='def';const next=await projectObservations(feed);assert.notEqual(next[0].fingerprint,first[0].fingerprint);assert.equal(next[1].fingerprint,first[1].fingerprint);
  feed.engineeringError='offline';assert.deepEqual(await projectObservations(feed),[]);
});
