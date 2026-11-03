import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createNotionBrowserLogin, notionLoginDiagnostic } from '../runtime/notion-browser-login.mjs';

const cookie=(domain='.notion.so',value='offline-notion')=>({name:'token_v2',value,domain,path:'/',expires:-1});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(t, options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'notion-browser-test-')),calls=[],writes=[],timers=new Map();let stored,time=100000,sequence=0;
 const context=new EventEmitter();context.rows=options.rows||[];context.pages=()=>[{goto:async url=>calls.push({url})}];
 context.cookies=async urls=>{calls.push({urls});return context.rows;};context.close=async()=>{calls.push({close:true});context.emit('close');};
 const helper=createNotionBrowserLogin({dataDir:dir,toolsDir:path.join(dir,'tools'),now:()=>time,
  scheduler:{setTimeout(fn,ms){const key=++sequence;timers.set(key,{fn,ms});return key;},clearTimeout(key){timers.delete(key);}},
  getSecret:()=>stored,setSecret:(key,value)=>{writes.push({key,value});stored=value;},
  launch:async(profile,settings)=>{calls.push({profile,settings});return context;},
  verifyCookies:options.verify||(()=>({ok:true})),...options.helper});
 t.after(async()=>{await helper.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{helper,calls,writes,context,timers,advance:n=>time+=n,async open(){await helper.login('start');await helper.tick();}};
}

test('Notion status never attaches to a browser; explicit login opens one isolated official window',async t=>{
 const f=fixture(t);await f.helper.login('status');assert.equal(f.calls.length,0);
 await f.open();assert.equal(f.calls[0].settings.headless,false);assert.equal(f.calls[0].settings.acceptDownloads,false);
 assert.equal(f.calls[1].url,'https://www.notion.so/login');assert.deepEqual(f.calls[2].urls,['https://www.notion.so/','https://www.notion.com/','https://app.notion.com/']);
 assert.equal(f.calls[0].settings.args.some(a=>/stealth|disable-blink|automationcontrolled/i.test(a)),false);
});

test('only valid first-party Notion session cookies are verified and sealed',async t=>{
 let seen;const f=fixture(t,{rows:[cookie(),{...cookie('.notion.com'),name:'notion_user_id',value:'user-one'},cookie('.notion.so.evil.test','foreign'),cookie('.google.com','foreign')],verify:header=>{seen=header;return{ok:true};}});
 await f.open();assert.equal((await f.helper.login('status')).state,'ready');assert.equal(f.writes.length,1);
 assert.equal(seen,'token_v2=offline-notion; notion_user_id=user-one');assert.equal(JSON.stringify(await f.helper.login('status')).includes('offline-notion'),false);
});

test('host-only Cloudflare cookies do not look like a second Notion account', async t => {
  let seen;
  const f = fixture(t, { rows: [cookie(), { name: '__cf_bm', value: 'edge-so', domain: '.notion.so', path: '/' }, { name: '__cf_bm', value: 'edge-com', domain: '.notion.com', path: '/' }], verify: header => { seen = header; return { ok: true }; } });
  await f.open();
  assert.equal((await f.helper.login('status')).state, 'ready');
  assert.equal(seen, 'token_v2=offline-notion; __cf_bm=edge-so');
});

test('closing the window after the session is visible still saves that login', async t => {
  const waiting = deferred();
  const f = fixture(t, { rows: [cookie()], verify: () => waiting.promise });
  await f.helper.login('start');
  const ticking = f.helper.tick();
  f.context.emit('close');
  waiting.resolve({ ok: true });
  await ticking;
  assert.equal(f.writes.length, 1);
  assert.equal((await f.helper.login('status')).state, 'ready');
});

test('lookalike, expired, injected and conflicting sessions never authenticate',async t=>{
 for(const rows of [[cookie('notnotion.so')],[cookie('notion.so.evil.test')],[cookie('.notion.com','a\r\nX:secret')],[{...cookie(),expires:1}],[cookie(),cookie('.notion.com','different-user')]]){
  const f=fixture(t,{rows,verify:()=>assert.fail('invalid cookies reached verification')});await f.open();assert.equal(f.writes.length,0);assert.equal((await f.helper.login('status')).state,'pending');await f.helper.login('cancel');
 }
});

test('a device/access challenge keeps the official window open instead of attempting bypass',async t=>{
 let calls=0;const f=fixture(t,{rows:[cookie()],verify:()=>{calls++;throw Object.assign(new Error('private-body'),{data:{code:'access_denied',httpStatus:403}});}});
 await f.open();const state=await f.helper.login('status');assert.equal(state.state,'pending');assert.equal(state.diagnostic.code,'access_denied');
 assert.equal(f.calls.some(c=>c.close),false);assert.equal(f.writes.length,0);f.advance(5000);await f.helper.tick();assert.equal(calls,1);assert.equal(JSON.stringify(state).includes('private-body'),false);
});

test('cancelling a verification prevents late credential persistence',async t=>{
 const waiting=deferred(),entered=deferred();const f=fixture(t,{rows:[cookie()],verify:()=>{entered.resolve();return waiting.promise;}});
 await f.helper.login('start');const ticking=f.helper.tick();await entered.promise;await f.helper.login('cancel');waiting.resolve({ok:true});await ticking;
 assert.equal(f.writes.length,0);assert.equal((await f.helper.login('status')).state,'idle');
});

test('Notion login diagnostics expose stable categories only',()=>{
 const d=notionLoginDiagnostic({data:{code:'secret-token',stage:'secret-url',httpStatus:'secret',message:'cookie'}});
 assert.deepEqual(d,{stage:'verification',code:'verification_failed',retryable:false});
 assert.deepEqual(notionLoginDiagnostic({data:{code:'credits_exhausted',stage:'models',httpStatus:402}}),{stage:'models',code:'credits_exhausted',retryable:false,httpStatus:402});
});
