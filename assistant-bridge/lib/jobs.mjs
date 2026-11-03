import { canonical, fail, hash, identifier, snapshot, string, terminal, touch } from './util.mjs';
import { httpsUrl } from './webhook.mjs';
import { dotsEventIdentity } from './events.mjs';

export class Jobs {
  constructor({store,events,webhookFetch,publicUrl}) {Object.assign(this,{store,events,webhookFetch,publicUrl});this.pending=new Set();}
  status(agentId,protocol) {
    identifier(agentId,'agentId');if(!['grok-webhook','dots-mcp'].includes(protocol))fail(400,'unsupported_protocol','This native protocol is not supported.');
    const subscriptions=this.events.active(agentId);const agent=this.store.data.agents[agentId];
    const connected=Boolean(agent?.lastSeenAt && this.events.isPrincipalActive(agent.principalId));
    let readiness='ready',message='原生回传通道已就绪。';
    if(!this.publicUrl){readiness='needs_public_url';message='请配置云端助理能够访问的 HTTPS MCP 地址。';}
    else if(!connected){readiness='needs_agent_connection';message='请先在助理中连接 AntDesk MCP，并运行一次读取工具。';}
    else if(protocol==='dots-mcp'&&subscriptions.length!==1){readiness='needs_subscription';message='请让 DOTS 订阅当前助理编号的事项分配事件。';}
    else if(protocol==='grok-webhook') message='MCP 回传通道已连接；此检查不会启动 Grok，也不会验证工作流程密钥。';
    return {service:'antdesk-native-bridge',version:1,agentId,protocol,publicUrl:this.publicUrl,mcpUrl:this.publicUrl?this.publicUrl+'/mcp':'',ready:readiness==='ready',readiness,subscriptionCount:subscriptions.length,message};
  }
  create(input) {
    const value={id:identifier(input.id),idempotencyKey:identifier(input.idempotencyKey,'idempotencyKey'),taskId:identifier(input.taskId,'taskId'),title:string(input.title,'title',4000),instruction:string(input.instruction,'instruction',40000),
      context:string(input.context,'context',262144,true),parentRunId:input.parentRunId?identifier(input.parentRunId,'parentRunId'):null,agentId:identifier(input.agentId,'agentId'),protocol:input.protocol};
    if(!['grok-webhook','dots-mcp'].includes(value.protocol))fail(400,'unsupported_protocol','Only official Grok webhook and DOTS MCP Events are available.');
    if(value.protocol==='grok-webhook') {const url=httpsUrl(input.webhookUrl);if(url.search)fail(400,'invalid_url','Keep webhook secrets out of URL query strings.');value.webhookUrl=url.toString();string(input.webhookKey,'webhookKey',8192);if(/[\r\n]/.test(input.webhookKey))fail(400,'invalid_key','The webhook key is invalid.');}
    const fingerprint=hash(canonical(value));
    const prior=this.store.data.runs[value.id]||Object.values(this.store.data.runs).find(r=>r.idempotencyKey===value.idempotencyKey);
    if(prior) {if(prior.fingerprint!==fingerprint)fail(409,'idempotency_conflict','This request identity already belongs to a different task.');return {created:false,run:snapshot(prior)};}
    if(this.store.data.tombstones[value.id])fail(409,'cancelled','This execution was cancelled before dispatch.');
    const readiness=this.status(value.agentId,value.protocol);if(!readiness.ready)fail(409,value.protocol==='dots-mcp'&&readiness.readiness==='needs_subscription'?'subscription_required':readiness.readiness,readiness.message);
    if(Object.values(this.store.data.runs).some(r=>r.taskId===value.taskId&&['queued','running','interrupted'].includes(r.status)))fail(409,'task_active','An assistant is already handling this task, or an earlier dispatch is unconfirmed. Check the assistant or cancel that execution before retrying.');
    if(Object.keys(this.store.data.runs).length>=10000)fail(429,'capacity','The bridge task history is full. Export or archive old history before adding more tasks.');
    const at=Date.now();const run={...value,fingerprint,status:'queued',deliveryStatus:'pending',progress:'',result:'',error:'',createdAt:at,updatedAt:at,updates:{},claimedBy:null};
    const outbox=value.protocol==='dots-mcp'?this.events.makeOutbox(run):null;
    this.store.commit(s=>{s.runs[run.id]=run;if(outbox)s.outbox[outbox.id]=outbox;});
    if(value.protocol==='grok-webhook') {
      const promise=this.sendGrok(run.id,input.webhookKey).finally(()=>this.pending.delete(promise));this.pending.add(promise);
    } else void this.events.tick();
    return {created:true,run:snapshot(run)};
  }
  async sendGrok(id,key) {
    const run=this.store.data.runs[id];if(!run||terminal(run))return;
    let response,networkError=false;
    try {
      const body=JSON.stringify({run_id:run.id,task_id:run.taskId,agent_id:run.agentId,title:run.title,instruction:run.instruction,context:run.context,parent_run_id:run.parentRunId,antdesk_mcp_url:this.publicUrl+'/mcp'});
      response=await this.webhookFetch(run.webhookUrl,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body});
    }catch{networkError=true;}
    this.store.commit(s=>{
      const current=s.runs[id];if(!current)return;
      if(response?.status===200){current.deliveryStatus='accepted';if(!terminal(current)){current.status='running';current.error='';}touch(current);return;}
      if(terminal(current))return;
      current.deliveryStatus=networkError?'unknown':'rejected';current.status=networkError?'interrupted':'failed';
      current.error=networkError?'Grok 请求是否被接收尚未确认，未自动重发。请检查助理会话。':'Grok 工作流程未启动，HTTP '+String(response?.status||0)+'。请检查工作流程和密钥。';touch(current);
    });
  }
  get(id) {identifier(id);const run=this.store.data.runs[id];if(!run)fail(404,'run_not_found','No such execution exists.');return snapshot(run);}
  cancel(id) {
    identifier(id);
    return this.store.commit(s=>{
      const run=s.runs[id];
      if(!run){if(Object.keys(s.tombstones).length>=10000)fail(429,'capacity','Too many cancellation records.');const at=Date.now();s.tombstones[id]={at};return {id,status:'cancelled',deliveryStatus:'rejected',progress:'',result:'',error:'',updatedAt:at,remoteStopped:false};}
      if(['queued','running','interrupted'].includes(run.status)){run.status='cancelled';run.error='';touch(run);}
      for(const out of Object.values(s.outbox))if(out.runId===id&&out.status==='pending')out.status='closed';
      return {...snapshot(run),remoteStopped:false};
    });
  }
  own(principal,id) {
    identifier(id,'run_id');const run=this.store.data.runs[id];
    if(!run||!this.accessible(principal,run))fail(404,'task_not_found','This task is not available to the connected assistant.');return run;
  }
  accessible(principal,run) {
    if(run.agentId!==principal.agentId)return false;
    if(run.protocol==='dots-direct'){
      const bound=run.eventBinding;
      return Boolean(run.runtimeData?.transport==='events'&&bound&&bound.principalId===principal.principalId
        &&this.events.active(run.agentId).some(s=>s.id===bound.subscriptionId&&s.principalId===bound.principalId
          &&bound.identity===dotsEventIdentity(this.store.data.runtime?.providers?.['dots-direct']?.config?.tunnelId,s)));
    }
    return ['grok-webhook','dots-mcp'].includes(run.protocol);
  }
  task(run) {return {run_id:run.id,task_id:run.taskId,agent_id:run.agentId,title:run.title,instruction:run.instruction,context:run.context,parent_run_id:run.parentRunId,...snapshot(run)};}
  tool(principal,name,args={}) {
    if(name==='list_tasks')return {tasks:Object.values(this.store.data.runs).filter(r=>this.accessible(principal,r)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,100).map(r=>this.task(r))};
    const run=this.own(principal,args.run_id);
    if(name==='get_task')return this.task(run);
    if(!['claim_task','report_progress','submit_result','fail_task'].includes(name))fail(404,'unknown_tool','Unknown tool.');
    const text=name==='claim_task'?'':string(args.text,'text',name==='report_progress'?16000:262144);
    const key=name==='claim_task'?'claim':identifier(args.idempotency_key,'idempotency_key');
    const operation=hash(canonical({name,text,principal:principal.principalId}));
    if(run.updates[key]){if(run.updates[key]!==operation)fail(409,'idempotency_conflict','This update identity was already used for different content.');return this.task(run);}
    if(['cancelled','failed','review'].includes(run.status))fail(409,'task_closed','This task has already been closed.');
    if(run.claimedBy&&run.claimedBy!==principal.principalId)fail(409,'task_claimed','This task is claimed by another connection for this assistant.');
    return this.store.commit(s=>{
      const current=s.runs[run.id];if(Object.keys(current.updates).length>=2000)fail(429,'capacity','Too many updates for this task.');
      current.updates[key]=operation;current.claimedBy=principal.principalId;current.deliveryStatus='accepted';current.error='';
      if(name==='claim_task')current.status='running';
      if(name==='report_progress'){current.status='running';current.progress=text;}
      if(name==='submit_result'){current.status='review';current.result=text;}
      if(name==='fail_task'){current.status='failed';current.error=text;}
      touch(current);return this.task(current);
    });
  }
  async close(){await Promise.allSettled([...this.pending]);}
}
