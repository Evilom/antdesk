import { canonical, equal, fail, hash, random, terminal, touch } from './util.mjs';
import { httpsUrl, signedHeaders, signingKey } from './webhook.mjs';

export const EVENT_NAME = 'antdesk.task.assigned';
export const dotsEventIdentity = (tunnelId,sub) => hash(JSON.stringify(['dots-events',tunnelId,sub.id,sub.principalId]));
export const EVENT_DEFINITION = {
  name:EVENT_NAME, description:'A task is assigned to this connected AntDesk assistant.', delivery:['webhook'],
  inputSchema:{type:'object',properties:{agent_id:{type:'string',description:'The connected assistant identity.'}},required:['agent_id'],additionalProperties:false},
  payloadSchema:{type:'object',properties:{run_id:{type:'string'},task_id:{type:'string'},title:{type:'string'},agent_id:{type:'string'}},required:['run_id','task_id','title','agent_id'],additionalProperties:false},
};
export class Events {
  constructor({store,webhookFetch,retryDelaysMs=[1000,5000,20000],isPrincipalActive=()=>true}) {
    Object.assign(this,{store,webhookFetch,retryDelaysMs,isPrincipalActive}); this.busy=false; this.closed=false; this.inFlight=new Set();
  }
  active(agentId) {
    return Object.values(this.store.data.subscriptions).filter(s => s.agentId===agentId && s.active && (!s.expiresAt || s.expiresAt>Date.now()) && this.isPrincipalActive(s.principalId));
  }
  validate(principal,params) {
    if(params?.name!==EVENT_NAME || !params.arguments || Object.keys(params.arguments).length!==1 || params.arguments.agent_id!==principal.agentId) fail(403,'subscription_scope','Only your own assistant queue can be subscribed.');
    if(params.delivery?.mode!=='webhook') fail(400,'invalid_delivery','Only webhook delivery is supported.');
    const url=httpsUrl(params.delivery.url).toString();
    return {url,id:'sub_'+hash(canonical({principal:principal.principalId,url,name:EVENT_NAME,arguments:params.arguments})).slice(0,40)};
  }
  async subscribe(principal,params) {
    const {url,id}=this.validate(principal,params); signingKey(params.delivery.secret);
    if(this.active(principal.agentId).some(s=>s.id!==id)) fail(409,'subscription_conflict','This assistant already has a different active subscription. Stop the previous subscription before connecting another chat.');
    const ttl=params.ttlMs===undefined ? 86400000 : params.ttlMs;
    if(ttl!==null && (!Number.isSafeInteger(ttl)||ttl<1)) fail(400,'invalid_ttl','ttlMs must be a positive integer or null.');
    // All subscriptions expire; null requests are granted a finite seven-day lease.
    const old=this.store.data.subscriptions[id];let sameSecret=false;
    try {sameSecret=Boolean(old&&equal(this.store.unseal(old.secret),params.delivery.secret));} catch {}
    const cached=Boolean(sameSecret&&old.verifiedAt+300000>Date.now());
    if(!cached){
      const challenge=random();const messageId='verify_'+random(16);const body=JSON.stringify({type:'verification',challenge});
      let response,echoed;
      try {response=await this.webhookFetch(url,{method:'POST',redirect:'error',headers:signedHeaders(params.delivery.secret,messageId,body,id),body});echoed=await response.json();}
      catch {fail(502,'callback_verification_failed','The callback challenge could not be verified.');}
      if(!response.ok||typeof echoed?.challenge!=='string'||!equal(echoed.challenge,challenge))fail(502,'callback_verification_failed','The callback challenge was not echoed correctly.');
    }
    const expiresAt=Date.now()+Math.min(ttl===null?604800000:ttl,604800000);
    this.store.commit(s=>{
      if(Object.values(s.subscriptions).some(sub=>sub.agentId===principal.agentId&&sub.id!==id&&sub.active&&sub.expiresAt>Date.now()&&this.isPrincipalActive(sub.principalId))) fail(409,'subscription_conflict','Another chat subscribed while this callback was being verified.');
      const previous=s.subscriptions[id];
      s.subscriptions[id]={id,agentId:principal.agentId,principalId:principal.principalId,url,name:EVENT_NAME,arguments:params.arguments,
        secret:this.store.seal(params.delivery.secret),previousSecret:sameSecret?previous?.previousSecret:previous?.secret,
        rotationUntil:sameSecret?(previous?.rotationUntil||0):previous?Date.now()+60000:0,expiresAt,active:true,verifiedAt:cached?previous.verifiedAt:Date.now()};
    });
    return {id,refreshBefore:new Date(expiresAt).toISOString(),cursor:null,truncated:false};
  }
  unsubscribe(principal,params) {
    const {id}=this.validate(principal,params);
    this.store.commit(s=>{if(s.subscriptions[id]) s.subscriptions[id].active=false;});
    return {};
  }
  makeOutbox(run) {
    const subscriptions=this.active(run.agentId);
    if(subscriptions.length!==1) fail(409,'subscription_required','请先让 DOTS 订阅此助理的 AntDesk 事项事件。');
    const eventId='evt_'+hash(run.id).slice(0,40);
    return {id:eventId,eventId,runId:run.id,subscriptionId:subscriptions[0].id,attempts:0,nextAt:Date.now(),status:'pending',
      event:{eventId,name:EVENT_NAME,timestamp:new Date(run.createdAt).toISOString(),data:{run_id:run.id,task_id:run.taskId,title:run.title,agent_id:run.agentId},cursor:null}};
  }
  start() { this.timer=setInterval(()=>void this.tick(),100); this.timer.unref(); void this.tick(); }
  async tick() {
    if(this.closed||this.busy) return;
    this.busy=true;
    try { const pending=Object.values(this.store.data.outbox).filter(o=>o.status==='pending'&&o.nextAt<=Date.now()).slice(0,4); await Promise.all(pending.map(o=>this.deliver(o.id))); }
    finally { this.busy=false; }
  }
  async deliver(id) {
    const original=this.store.data.outbox[id]; if(!original||this.inFlight.has(id)) return;
    const subscription=this.store.data.subscriptions[original.subscriptionId]; const run=this.store.data.runs[original.runId];
    if(!run||terminal(run)) { this.store.commit(s=>{s.outbox[id].status='closed';}); return; }
    if(!subscription?.active||subscription.expiresAt<=Date.now()||!this.isPrincipalActive(subscription.principalId)) {
      this.store.commit(s=>{s.outbox[id].status='closed';const r=s.runs[original.runId];if(!terminal(r)){r.status='failed';r.deliveryStatus='rejected';r.error='助理的事件订阅已过期或停止，请重新订阅后派发新任务。';touch(r);}});return;
    }
    this.inFlight.add(id); this.store.commit(s=>{s.outbox[id].attempts++;});
    let response, networkError=false;
    try {
      const body=JSON.stringify(original.event), secret=this.store.unseal(subscription.secret);
      const headers=signedHeaders(secret,original.eventId,body,subscription.id);
      if(subscription.previousSecret&&subscription.rotationUntil>Date.now()) headers['webhook-signature']+=' '+signedHeaders(this.store.unseal(subscription.previousSecret),original.eventId,body,subscription.id)['webhook-signature'];
      response=await this.webhookFetch(subscription.url,{method:'POST',redirect:'error',headers,body});
    } catch { networkError=true; }
    finally { this.inFlight.delete(id); }
    if(this.closed) return;
    this.store.commit(s=>{
      const out=s.outbox[id], current=s.runs[out.runId]; if(out.status!=='pending') return;
      if(response?.ok){out.status='accepted';current.deliveryStatus='accepted';if(!terminal(current)) {current.status='running';current.error='';}touch(current);return;}
      if(terminal(current)){out.status='closed';return;}
      const retryable=networkError||response?.status===408||response?.status===429||response?.status>=500;
      if(retryable&&out.attempts<=this.retryDelaysMs.length){out.nextAt=Date.now()+this.retryDelaysMs[out.attempts-1];return;}
      out.status='failed';current.deliveryStatus=retryable?'unknown':'rejected';current.status=retryable?'interrupted':'failed';
      current.error=retryable?'事件投递结果尚未确认，已停止自动重试。请检查助理会话。':'事件接收端拒绝请求，HTTP '+String(response?.status||0)+'。请检查事件订阅。';touch(current);
      if(response?.status===410) s.subscriptions[out.subscriptionId].active=false;
    });
  }
  async close() {this.closed=true;clearInterval(this.timer);while(this.busy) await new Promise(resolve=>setTimeout(resolve,10));}
}
