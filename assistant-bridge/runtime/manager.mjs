import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError, canonical, fail, hash, identifier, snapshot, string, touch } from '../lib/util.mjs';

export const RUNTIME_PROTOCOLS = new Set(['grok-direct', 'muse-personal', 'muse-code', 'deepseek-harness', 'dots-direct', 'notion-web']);
// Discover the user's selected assistants. Keep runtime ownership
// broader so already-saved runs can still be inspected, stopped or recovered.
export const VISIBLE_PROVIDERS = Object.freeze(['muse-personal', 'grok-direct', 'dots-direct', 'notion-web']);
const ACTIVE = new Set(['queued', 'running', 'interrupted']);
const names = {'dots-direct':'Dots / omdot','grok-direct':'Grok 原 Bot', 'muse-personal':'原 Muse', 'muse-code':'Muse Code', 'deepseek-harness':'DeepSeek Harness', 'notion-web':'Notion AI'};
const clipped = (value, max = 32768) => typeof value === 'string' ? value.slice(0, max) : '';
const safeMessage = error => error instanceof BridgeError ? error.message : (error?.publicMessage || '助理连接暂时不可用，请查看连接状态后恢复。');

/** One durable owner for dispatch, attention and recovery. Secrets never enter snapshots. */
export class RuntimeManager {
  constructor({store, projectRoot, toolsDir, adapters, events, getDotsUpstream} = {}) {
    this.store = store;
    this.projectRoot = projectRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    this.toolsDir = toolsDir || path.join(this.projectRoot, '.antdesk/runtime-tools');
    this.dataDir = path.join(path.dirname(store.file), 'runtimes');
    this.adapters = new Map(); this.pending = new Map(); this.lastRecovery = new Map(); this.buffered = new Map(); this.closed = false;
    this.overrides = adapters; this.events = events; this.getDotsUpstream = getDotsUpstream;
    store.commit(s => {
      s.runtime ??= {providers:{}};
      for (const run of Object.values(s.runs)) if (RUNTIME_PROTOCOLS.has(run.protocol) && ['queued','running'].includes(run.status)) {
        // MCP events are durably owned by the outbox; their original task can
        // continue reporting after the desktop reconnects.
        if(run.runtimeData?.transport==='events'&&Object.values(s.outbox).some(o=>o.runId===run.id))continue;
        run.status = 'interrupted';
        if (run.deliveryStatus === 'pending') run.deliveryStatus = 'unknown';
        run.error = '连接中断。恢复时只查询原会话，不会重复派发任务。';
        touch(run);
      }
    });
  }
  owns(protocol) { return RUNTIME_PROTOCOLS.has(protocol); }
  ownsRun(id) { return this.owns(this.store.data.runs[id]?.protocol); }
  options(id) {
    const state = () => this.store.data.runtime.providers[id] || {};
    return {
      projectRoot:this.projectRoot, toolsDir:this.toolsDir, dataDir:path.join(this.dataDir, id),
      getSecret:key => state().secrets?.[key] ? this.store.unseal(state().secrets[key]) : undefined,
      setSecret:(key, value) => {
        identifier(key);
        this.store.commit(s => {const p = s.runtime.providers[id] ??= {config:{},secrets:{}}; p.secrets ??= {}; if (value) p.secrets[key] = this.store.seal(String(value)); else delete p.secrets[key];});
      },
      getConfig:() => structuredClone(state().config || {}),
      setConfig:patch => this.store.commit(s => {const p = s.runtime.providers[id] ??= {config:{},secrets:{}}; p.config = {...p.config, ...patch};}),
    };
  }
  async adapter(id) {
    if (!this.owns(id)) fail(400, 'invalid_provider', '不支持的助理类型。');
    if (!this.adapters.has(id)) this.adapters.set(id, (async () => {
      if (this.overrides?.[id]) return this.overrides[id];
      if (id === 'dots-direct') {
        const [{createDotsAuth}, {createDotsAdapter}, {createDotsChannel}, {createDotsTunnel}] = await Promise.all([import('./dots-auth.mjs'), import('./dots.mjs'), import('./dots-channel.mjs'), import('./dots-tunnel.mjs')]);
        const options = this.options(id);
        const auth = createDotsAuth(options);
        const direct=createDotsAdapter({...options, auth});
        if(!this.events||!this.getDotsUpstream)return direct;
        const tunnel=createDotsTunnel({...options,getUpstream:this.getDotsUpstream});
        return createDotsChannel({...options,direct,tunnel,store:this.store,events:this.events});
      }
      const file = {'grok-direct':'grok', 'muse-personal':'muse-personal', 'muse-code':'muse-code', 'deepseek-harness':'deepseek', 'notion-web':'notion-web'}[id];
      const factory = {'grok-direct':'createGrokAdapter', 'muse-personal':'createMusePersonalAdapter', 'muse-code':'createMuseAdapter', 'deepseek-harness':'createDeepSeekAdapter', 'notion-web':'createNotionWebAdapter'}[id];
      const module = await import('./' + file + '.mjs');
      return module[factory](this.options(id));
    })());
    return this.adapters.get(id);
  }
  async providers() {
    const providers = await Promise.all(VISIBLE_PROVIDERS.map(async id => {
      try { return {...await (await this.adapter(id)).status(), id, protocol:id}; }
      catch { return {id,protocol:id,name:names[id],official:!['grok-direct','muse-personal','dots-direct','notion-web'].includes(id),installed:false,readiness:'unavailable',message:'助理组件未能启动，请重试连接检查。'}; }
    }));
    return {providers};
  }
  async providerAction(id, action, body = {}, query = {}) {
    const adapter = await this.adapter(id);
    if (action === 'agents') return adapter.agents ? await adapter.agents(query) : {agents:[]};
    if (action === 'sessions') {
      const result = adapter.sessions ? await adapter.sessions(query) : {sessions:[]};
      return {...result,sessions:(result.sessions || []).map(session=>({...session,title:session.title || session.name || '未命名会话'}))};
    }
    if (action === 'configure') { if (!adapter.configure) fail(400,'not_supported','此助理无需填写密钥。'); return adapter.configure(body); }
    if (action === 'logout') return adapter.login('logout',body);
    if (action.startsWith('login/')) return adapter.login(action.slice(6),body);
    fail(404,'not_found','没有这个助理操作。');
  }
  async status(agentId, protocol) {
    const status = await (await this.adapter(protocol)).status(protocol === 'dots-direct' ? {agentId} : undefined);
    const noBot = ['grok-direct','dots-direct'].includes(protocol) && (!agentId || ['grokbot','grok-direct','omdot-direct','dots-direct','gptdot','dots'].includes(agentId));
    return {...status,ok:status.readiness === 'ready' && !noBot,ready:status.readiness === 'ready' && !noBot,readiness:noBot && status.readiness === 'ready' ? 'needs_agent_connection' : status.readiness,message:noBot && status.readiness === 'ready' ? '已登录，请选择要协作的原 Bot。' : status.message};
  }
  async create(input) {
    const value = {
      id:identifier(input.id), idempotencyKey:identifier(input.idempotencyKey,'idempotencyKey'),
      taskId:identifier(input.taskId,'taskId'), title:string(input.title,'title',4000),
      instruction:string(input.instruction,'instruction',40000), context:string(input.context,'context',262144,true),
      parentRunId:string(input.parentRunId,'parentRunId',256,true), agentId:identifier(input.agentId,'agentId'),
      protocol:string(input.protocol,'protocol',64), sessionId:string(input.sessionId,'sessionId',256,true),
    };
    if (!this.owns(value.protocol)) fail(400,'invalid_protocol','不支持的助理协议。');
    if (value.protocol === 'notion-web') value.model = string(input.model ?? '', 'model', 256, true);
    const fingerprint = hash(canonical(value));
    const existing = () => {
      const prior = this.store.data.runs[value.id] || Object.values(this.store.data.runs).find(r => r.idempotencyKey === value.idempotencyKey);
      if (prior) { if (prior.fingerprint !== fingerprint) fail(409,'idempotency_conflict','该派发编号已用于其他任务。'); return {created:false,run:snapshot(prior)}; }
      if (this.store.data.tombstones[value.id]) fail(409,'run_cancelled','这次派发已经取消。');
      if (Object.values(this.store.data.runs).some(r => r.taskId === value.taskId && ACTIVE.has(r.status))) fail(409,'task_busy','该事项仍有运行中的助理，请先完成、停止等待或恢复原任务。');
      if (['grok-direct','dots-direct'].includes(value.protocol) && Object.values(this.store.data.runs).some(r => r.protocol === value.protocol && r.agentId === value.agentId && ACTIVE.has(r.status))) fail(409,'agent_busy','这个 Bot 仍在处理另一事项。请等待它完成，或选择另一个 Bot 并行协作。');
    };
    const prior = existing(); if (prior) return prior;
    const adapter = await this.adapter(value.protocol);
    const status = await this.status(value.agentId,value.protocol);
    if (!status.ok) fail(409,status.readiness,status.message);
    const rechecked = existing(); if (rechecked) return rechecked;
    const runtimeData=adapter.prepare?await adapter.prepare(value,status):{};
    const afterPrepare=existing();if(afterPrepare)return afterPrepare;
    const workingDirectory = path.join(this.projectRoot,'.antdesk/assistant-workspaces',hash(value.id).slice(0,32));
    fs.mkdirSync(workingDirectory,{recursive:true});
    const now = Date.now();
    const run = {...value,fingerprint,workingDirectory,status:'queued',deliveryStatus:'pending',progress:'正在连接助理…',result:'',error:'',createdAt:now,updatedAt:now,messages:[],runtimeData,updates:{},claimedBy:null};
    this.store.commit(s => {s.runs[run.id] = run;});
    this.launch(run,adapter,'start');
    return {created:true,run:snapshot(this.store.data.runs[run.id])};
  }
  launch(run, adapter, method) {
    if (this.closed || this.pending.has(run.id)) return;
    const promise = Promise.resolve().then(() => adapter[method](structuredClone(run),event => this.emit(run.id,event)))
      .then(() => {
        const current = this.store.data.runs[run.id];
        if (!this.closed && current && ['queued','running'].includes(current.status) && !current.attention)
          this.emit(run.id,{type:'interrupted',message:'连接已结束，尚未收到任务完成确认。可以恢复读取原会话。',deliveryStatus:current.deliveryStatus === 'pending' ? 'unknown' : current.deliveryStatus});
      }).catch(error => this.emit(run.id,{type:'interrupted',message:safeMessage(error),deliveryStatus:this.store.data.runs[run.id]?.deliveryStatus === 'pending' ? 'unknown' : undefined}))
      .finally(() => this.pending.delete(run.id));
    this.pending.set(run.id,promise);
  }
  flush(id) {
    const batch=this.buffered.get(id);if(!batch)return;
    clearTimeout(batch.timer);this.buffered.delete(id);
    for(const event of batch.events.values())this.emit(id,event,true);
  }
  emit(id,event,immediate=false) {
    if (this.closed || !event || !this.store.data.runs[id] || ['cancelled','failed','review'].includes(this.store.data.runs[id].status)) return;
    if(!immediate && ['message','progress'].includes(event.type)){
      let batch=this.buffered.get(id);
      if(!batch){batch={events:new Map(),timer:setTimeout(()=>this.flush(id),100)};batch.timer.unref?.();this.buffered.set(id,batch);}
      batch.events.set(event.type==='message'?'message:'+event.id:'progress',{...event,text:clipped(event.text,event.type==='message'?16384:8192)});return;
    }
    if(!immediate)this.flush(id);
    this.store.commit(s => {
      const r = s.runs[id];
      for (const key of ['sessionId','turnId','cursor']) if (typeof event[key] === 'string') r[key] = clipped(event[key],4096);
      switch (event.type) {
        case 'checkpoint': r.runtimeData = {...r.runtimeData,...event.data}; break;
        case 'started': r.status='running';r.deliveryStatus='accepted';r.error='';r.progress='助理已接收，正在处理';break;
        case 'progress': r.progress=clipped(event.text,8192);break;
        case 'message': {
          if (!['assistant','tool','user'].includes(event.role) || !event.id) break;
          r.messages ??= []; const message={id:clipped(event.id,256),role:event.role,text:clipped(event.text,16384),complete:event.complete===true,updatedAt:Date.now()};
          const index=r.messages.findIndex(m=>m.id===message.id); if(index>=0) r.messages[index]=message; else r.messages.push(message);
          if(r.messages.length>40) r.messages=r.messages.slice(-40); break;
        }
        case 'attention': if(r.attention?.id!==event.attention?.id)delete r.attentionResponse;r.attention=event.attention;r.progress=clipped(event.attention?.title,8192);break;
        case 'attention-cleared': delete r.attention;break;
        case 'complete': r.status='review';r.deliveryStatus='accepted';r.result=clipped(event.text,262144);r.progress='助理已完成，等待你验收';r.error='';delete r.attention;break;
        case 'failed': r.status='failed';r.error=clipped(event.message,8192);r.deliveryStatus=event.deliveryStatus||r.deliveryStatus;delete r.attention;break;
        case 'interrupted': r.status='interrupted';r.error=clipped(event.message,8192);if(event.deliveryStatus)r.deliveryStatus=event.deliveryStatus;break;
        default: break;
      }
      touch(r);
    });
  }
  get(id) {
    const run = this.store.data.runs[id]; if (!run || !this.owns(run.protocol)) fail(404,'run_not_found','找不到这个助理任务。');
    if (run.status === 'interrupted' && !this.pending.has(id) && Date.now()-(this.lastRecovery.get(id)||0)>15000) {
      this.lastRecovery.set(id,Date.now());
      this.adapter(run.protocol).then(adapter=>{if(adapter.recover)this.launch(this.store.data.runs[id],adapter,'recover');}).catch(()=>{});
    }
    return snapshot(run);
  }
  async cancel(id) {
    const run = this.store.data.runs[id];if(!run||!this.owns(run.protocol))fail(404,'run_not_found','找不到这个助理任务。');
    if (!ACTIVE.has(run.status)) return {...snapshot(run),remoteStopped:run.remoteStopped===true};
    let outcome = {remoteStopped:false};
    try { const adapter=await this.adapter(run.protocol); if(adapter.cancel) outcome=await adapter.cancel(structuredClone(run)); } catch {}
    this.store.commit(s=>{const r=s.runs[id];if(!ACTIVE.has(r.status))return;r.status='cancelled';r.remoteStopped=outcome.remoteStopped===true;r.progress=outcome.remoteStopped?'已停止助理任务':'已停止本地等待，远端可能仍在执行';r.error='';delete r.attention;touch(r);});
    return {...snapshot(this.store.data.runs[id]),remoteStopped:outcome.remoteStopped===true};
  }
  async respond(id,body) {
    const run=this.store.data.runs[id];if(!run||!this.owns(run.protocol))fail(404,'run_not_found','找不到这个助理任务。');
    if (!run.attention || body.attentionId!==run.attention.id) fail(409,'attention_stale','这条确认事项已经过期，请刷新任务。');
    if (run.attentionResponse?.id===body.attentionId) fail(409,'attention_pending','这条答复正在确认是否送达，请刷新原会话，避免重复提交。');
    if (!ACTIVE.has(run.status)) fail(409,'run_closed','任务已经结束。');
    const adapter=await this.adapter(run.protocol);if(!adapter.respond)fail(400,'not_supported','请在该助理的原会话里处理这项确认。');
    // Persist intent before sending an approval: a timed-out answer must never be replayed blindly.
    this.store.commit(s=>{const r=s.runs[id];if(r.attentionResponse?.id===body.attentionId)fail(409,'attention_pending','答复正在处理。');r.attentionResponse={id:body.attentionId,state:'sending',at:Date.now()};touch(r);});
    const result=await adapter.respond(structuredClone(run),body);
    if(result?.ok!==false && this.store.data.runs[id]?.attention?.id===body.attentionId)this.emit(id,{type:'attention-cleared'});
    return {...result,run:snapshot(this.store.data.runs[id])};
  }
  async close() {
    if(this.closed)return;for(const id of this.buffered.keys())this.flush(id);this.closed=true;
    this.store.commit(s=>{for(const r of Object.values(s.runs))if(this.owns(r.protocol)&&['queued','running'].includes(r.status)&&!(r.runtimeData?.transport==='events'&&Object.values(s.outbox).some(o=>o.runId===r.id))){r.status='interrupted';if(r.deliveryStatus==='pending')r.deliveryStatus='unknown';r.error='AntDesk 连接已关闭，重新打开后可以恢复原会话。';touch(r);}});
    await Promise.allSettled([...this.adapters.values()].map(async p=>(await p).close?.()));
    let timer;await Promise.race([Promise.allSettled([...this.pending.values()]),new Promise(resolve=>{timer=setTimeout(resolve,2500);})]);clearTimeout(timer);
  }
}
