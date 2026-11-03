import { fail, touch } from '../lib/util.mjs';
import { dotsEventIdentity } from '../lib/events.mjs';

export const DOT_EVENTS_AGENT = 'omdot-events';
export const DOT_SETUP_MESSAGE = `请把这个原有 Dot 会话连接到我的 AntDesk。使用我已添加的 AntDesk MCP 插件：
1. 订阅 antdesk.task.assigned 事件，arguments 为 {"agent_id":"omdot-events"}，使用平台提供的 webhook 回调，并按 refreshBefore 续订。
2. 收到事件后，用 get_task 读取 run_id，再用 claim_task 接单。只按任务内的 instruction 和 context 回应；context 会标明助理群或独立私聊，请勿把其他私聊或会话记忆带入。用户要求评审优先顺序时，先用 list_priority_queue 读取队列、版本和项目约束，再用 reorder_priority_queue 提交顺序与 rationale 理由。启用 PMO 时只生成待用户采纳的建议，收到 proposalId 不表示队列已改变；不得自行增加范围或启动项目。
3. 请以你自己的身份发言。需要时用 report_progress 回报进度，完成后用 submit_result 将完整回复传回 AntDesk。更新使用稳定、唯一的 idempotency_key，重试同一更新时保持不变；失败用 fail_task。
4. 如果 get_task 显示 cancelled、failed 或 review，请不要再次执行。重复事件只检查原任务，不要重复产生副作用。不要根据其他助理消息自行派发新任务。
请先完成事件订阅并告诉我结果；不要创建另一位 Dot，也不要修改我的其他会话。`;

const active = run => ['queued','running','interrupted'].includes(run.status);
const transportOf = run => run.runtimeData?.transport || (run.agentId === DOT_EVENTS_AGENT ? 'events' : 'direct');

/** Select a transport for the existing Dot. The event route never uses Codex
 * tokens or client attestation; it serves the Dot's own official MCP session. */
export function createDotsChannel({direct,tunnel,store,events,getConfig,setConfig}) {
  let closed = false;
  const waiting = new Map();
  // Official events are the default for a new or blocked direct connection.
  // An explicitly saved direct route remains available for protocol diagnostics.
  const mode = () => getConfig().transport === 'direct' ? 'direct' : 'events';
  const subscriptions = () => events.active(DOT_EVENTS_AGENT);
  const binding = sub => dotsEventIdentity(getConfig().tunnelId,sub);
  const busy = () => Object.values(store.data.runs).some(r=>r.protocol==='dots-direct' && active(r));
  const stopWaiting = id => { const cancel=waiting.get(id); if(cancel)cancel(); };

  async function status(query={}) {
    const tunnelStatus = await tunnel.status();
    const subs = subscriptions();
    const seen=store.data.agents[DOT_EVENTS_AGENT];
    const confirmed=Boolean(tunnelStatus.startedAt&&seen?.lastSeenAt>=tunnelStatus.startedAt&&
      (!subs.length||subs.some(sub=>sub.principalId===seen.principalId)));
    const visibleTunnel={...tunnelStatus,state:tunnelStatus.state==='ready'&&!confirmed?'starting':tunnelStatus.state};
    const shared = {tunnel:visibleTunnel,subscriptionCount:subs.length,setupMessage:DOT_SETUP_MESSAGE,
      ...(seen?.mcpActivity?{mcpActivity:seen.mcpActivity}:{})};
    if(mode()==='direct') {
      const current=await direct.status(query);
      if(current.reason!=='device_verification_required')return {...current,...shared,transport:'direct'};
      // A successful account login is not proof that private Dot HTTP endpoints
      // accept this client. Move only this known blocked state to the supported
      // event route; other direct errors must remain visible and untouched.
      setConfig({transport:'events'});
    }
    let readiness='ready',message='官方 Tunnel 与原 Dot 事件订阅已就绪。';
    if(!tunnelStatus.installed){readiness='needs_install';message='请先安装官方 OpenAI Tunnel 客户端。';}
    else if(!tunnelStatus.configured){readiness='needs_configuration';message='创建官方 Tunnel 后，填写 Tunnel ID 和运行密钥。';}
    else if(tunnelStatus.state!=='ready'){readiness=tunnelStatus.state==='starting'?'connecting':'unavailable';message=tunnelStatus.error||'官方 Tunnel 尚未连接，请点击启动连接。';}
    else if(!confirmed){readiness='needs_validation';message='Tunnel 本机检查已通过。请在 ChatGPT 中连接 AntDesk 插件，收到本次连接的实际请求后才会确认在线。';}
    else if(subs.length!==1){readiness='needs_subscription';message='Tunnel 已连通。请把 AntDesk 插件加入原 Dot，并让它订阅事项事件。';}
    const sub=subs.length===1?subs[0]:null;
    return {...shared,transport:'events',id:'dots-direct',name:'Dots / omdot',official:true,installed:tunnelStatus.installed,
      readiness,message,agentId:DOT_EVENTS_AGENT,sessionId:sub?.id||'',
      ...(sub?{connectionIdentity:binding(sub)}:{})};
  }
  async function configure(input={}) {
    const next=input.transport===undefined?mode():input.transport;
    if(!['direct','events'].includes(next))fail(400,'invalid_transport','请选择原会话直连或官方事件连接。');
    if(input.action && !['start','stop','refresh'].includes(input.action))fail(400,'invalid_action','不支持这个连接操作。');
    const modifying=next!==mode()||input.tunnelId!==undefined||input.tunnelApiKey!==undefined||input.action==='stop';
    if(modifying && busy())fail(409,'agent_busy','原 Dot 还有未结束的任务，请先同步或停止跟进，再修改连接方式。');
    const previousTunnel=getConfig().tunnelId;
    if(input.tunnelId!==undefined||input.tunnelApiKey!==undefined) {
      try {await tunnel.configure({tunnelId:input.tunnelId??previousTunnel,tunnelApiKey:input.tunnelApiKey});}
      catch(error){fail(400,error?.code||'tunnel_configuration_failed',error?.message||'Tunnel 设置未保存，请检查输入。');}
      if(getConfig().tunnelId!==previousTunnel)store.commit(s=>{for(const sub of Object.values(s.subscriptions))if(sub.agentId===DOT_EVENTS_AGENT)sub.active=false;});
    }
    // Chat transport and the MCP plugin tunnel are independent: direct chat
    // still needs the official tunnel for reading tasks and proposing reviews.
    if(next!==mode())setConfig({transport:next});
    if(input.action==='stop'){setConfig({tunnelEnabled:false});await tunnel.stop();}
    else if(input.action==='start'){setConfig({tunnelEnabled:true});await tunnel.start();}
    return status({refresh:input.action==='refresh'});
  }
  async function agents(query) {
    if(mode()==='direct')return direct.agents(query);
    const value=await status();
    return {agents:value.readiness==='ready'?[{id:DOT_EVENTS_AGENT,name:'omdot',sessionId:value.sessionId}]:[],message:value.message};
  }
  async function sessions(query) {
    if(mode()==='direct')return direct.sessions(query);
    const value=await status();
    return {sessions:value.readiness==='ready'?[{id:value.sessionId,title:'原 omdot · AntDesk 事件会话'}]:[]};
  }
  function prepare(value,current) {
    if(mode()==='events' && value.agentId!==DOT_EVENTS_AGENT)fail(409,'needs_agent_connection','请保存 omdot 的官方事件连接配置。');
    if(mode()==='direct' && value.agentId===DOT_EVENTS_AGENT)fail(409,'needs_agent_connection','当前使用原会话直连，请重新选择原 Dot 并保存连接。');
    if(mode()==='events' && value.sessionId && value.sessionId!==current.sessionId)fail(409,'account_changed','原 Dot 的事件会话已更换，请在当前会话重新发送。');
    return {transport:mode(),connectionIdentity:current.connectionIdentity,
      ...(mode()==='events'?{eventSubscriptionId:current.sessionId}:{})};
  }
  async function waitForResult(runId) {
    if(waiting.has(runId)||closed)return;
    await new Promise(resolve=>{
      const finish=()=>{clearInterval(timer);waiting.delete(runId);resolve();};
      const timer=setInterval(()=>{const r=store.data.runs[runId];if(closed||!r||!['queued','running'].includes(r.status))finish();},250);
      timer.unref?.();waiting.set(runId,finish);
    });
  }
  async function start(run,emit) {
    if(transportOf(run)==='direct')return direct.start(run,emit);
    if(closed) return;
    const current=await status(),sub=subscriptions().find(s=>s.id===run.runtimeData?.eventSubscriptionId);
    if(current.transport!=='events'||current.readiness!=='ready'||!sub||binding(sub)!==run.runtimeData?.connectionIdentity){
      emit({type:'failed',deliveryStatus:'rejected',message:'原 Dot 的连接或订阅已变化。这条消息没有派发，请检查连接后重新发送。'});return;
    }
    const existing=Object.values(store.data.outbox).find(o=>o.runId===run.id);
    if(!existing){
      const outbox=events.makeOutbox(run);
      if(outbox.subscriptionId!==sub.id){emit({type:'failed',deliveryStatus:'rejected',message:'原 Dot 的订阅已更换，请重新发送。'});return;}
      store.commit(s=>{const r=s.runs[run.id];if(!r||!['queued','running'].includes(r.status))return;
        r.updates??={};r.claimedBy??=null;r.eventBinding={subscriptionId:sub.id,principalId:sub.principalId,identity:binding(sub)};
        r.progress='正在通知原 Dot…';s.outbox[outbox.id]=outbox;touch(r);});
      void events.tick();
    }
    await waitForResult(run.id);
  }
  async function recover(run,emit) {
    if(transportOf(run)==='direct')return direct.recover(run,emit);
    // The durable outbox owns event delivery. Never create a second dispatch on
    // recovery; accepted/unknown events may still report through their MCP task.
    const outbox=Object.values(store.data.outbox).find(o=>o.runId===run.id);
    if(!outbox){emit({type:'failed',deliveryStatus:'rejected',message:'这次原 Dot 通知未建立投递记录，未自动重发。请明确重试。'});return;}
    if(outbox.status==='pending')void events.tick();
  }
  async function cancel(run) {
    if(transportOf(run)==='direct')return direct.cancel(run);
    store.commit(s=>{for(const out of Object.values(s.outbox))if(out.runId===run.id&&out.status==='pending')out.status='closed';});
    stopWaiting(run.id);return {remoteStopped:false};
  }
  return {status,configure,agents,sessions,prepare,start,recover,cancel,
    login:(...args)=>direct.login(...args),
    respond:(run,body)=>transportOf(run)==='direct'?direct.respond?.(run,body):fail(400,'not_supported','请在原 Dot 会话中处理这个确认。'),
    async resume(){if(!closed&&getConfig().tunnelEnabled===true)await tunnel.start();},
    async close(){closed=true;for(const id of [...waiting.keys()])stopWaiting(id);await Promise.allSettled([tunnel.close(),direct.close()]);}
  };
}
