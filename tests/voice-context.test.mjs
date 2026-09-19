import assert from 'node:assert/strict';
import test from 'node:test';
import {VoiceContextQueue,voiceContextIntent,voiceSessionContext,voiceLookupContext} from '../src/lib/voice-context.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function fixture(t){t.mock.timers.enable({apis:['setTimeout']});const queue=new VoiceContextQueue();t.after(()=>queue.reset());const sent=[],errors=[];return {queue,sent,errors,send:t=>sent.push(t),fail:e=>errors.push(e)};}

test('casual speech and acknowledgments never request another voice turn',()=>{
  for(const text of ['大师我在听','在吗','我今天很开心','这个项目还不错','刚才我在工作','今天早上写完了文档','继续','谢谢','记住了吗？','记住吗？']) assert.equal(voiceContextIntent(text),null,text);
  for(const text of ['现在项目做到哪了','看看 Git 构建结果','今天做了啥','帮我找之前的文档','下一步是什么？']) assert.equal(voiceContextIntent(text),'lookup',text);
  assert.equal(voiceContextIntent('请帮我记住：周五交稿'),'remember');
});
test('transcript revisions debounce into one lookup and late revisions cannot send again',async t=>{
  const f=fixture(t);let prepared=0;
  const observe=text=>f.queue.observe({id:'one',text},async()=>{prepared++;return text;},f.send,f.fail);
  observe('项目进度怎么样');t.mock.timers.tick(900);observe('项目进度怎么样，今天构建通过了吗？');
  t.mock.timers.tick(1500);await tick();assert.equal(prepared,1);assert.equal(f.sent.length,1);
  observe('项目进度怎么样，今天构建通过了吗？。');t.mock.timers.tick(3000);await tick();assert.equal(prepared,1);assert.equal(f.sent.length,1);
});
test('a revised utterance invalidates its in-flight lookup',async t=>{
  const f=fixture(t),old=deferred();
  f.queue.observe({id:'one',text:'今天的项目怎么样？'},()=>old.promise,f.send,f.fail);t.mock.timers.tick(1500);
  f.queue.observe({id:'one',text:'今天的项目测试结果怎么样？'},async()=> '新结果',f.send,f.fail);t.mock.timers.tick(1500);await tick();old.resolve('旧结果');await tick();assert.deepEqual(f.sent,['新结果']);
});
test('new speech cancels old retrieval, including casual speech and delayed old captions',async t=>{
  const f=fixture(t),old=deferred();let lookups=0;
  f.queue.observe({id:'old',text:'项目进展如何？'},()=>old.promise,f.send,f.fail);t.mock.timers.tick(1500);
  f.queue.observe({id:'new',text:'不用查了，聊点别的'},async()=>{lookups++;return '不应发送';},f.send,f.fail);
  old.resolve('迟到结果');await tick();
  f.queue.observe({id:'old',text:'项目进展如何？。'},async()=>{lookups++;return '不应发送';},f.send,f.fail);
  t.mock.timers.tick(3000);await tick();assert.deepEqual(f.sent,[]);assert.equal(lookups,0);
});
test('stop or typed question cancels pending context and reconnect reset permits new identifiers',async t=>{
  const f=fixture(t);const observe=()=>f.queue.observe({id:'one',text:'今天做了啥？'},async()=> '事实',f.send,f.fail);
  observe();f.queue.cancel();t.mock.timers.tick(2000);await tick();assert.deepEqual(f.sent,[]);
  observe();t.mock.timers.tick(2000);await tick();assert.deepEqual(f.sent,[]);
  f.queue.reset();observe();t.mock.timers.tick(2000);await tick();assert.deepEqual(f.sent,['事实']);
});
test('retrieval failure remains local and does not trigger a spoken error or acknowledgment',async t=>{
  const f=fixture(t);f.queue.observe({id:'one',text:'项目怎么样？'},async()=>{throw new Error('offline');},f.send,f.fail);t.mock.timers.tick(1500);await tick();assert.equal(f.sent.length,0);assert.equal(f.errors[0].message,'offline');
});
test('prompt boundaries and quiet startup instruction survive long facts',()=>{
  const context=voiceSessionContext('资料'.repeat(6000),'历史'.repeat(2000));assert.equal(context.length,8000);assert.ok(context.endsWith('等用户实际发言后再回答。'));assert.match(context,/背景结束/);
  assert.match(voiceSessionContext('事实','历史',true),/用户点击了听汇报/);
  const lookup=voiceLookupContext('今天做了什么？','事实'.repeat(6000));assert.equal(lookup.length,8000);assert.match(lookup,/原问题：今天做了什么/);assert.ok(lookup.endsWith('不复述这条客户端消息。'));
});
