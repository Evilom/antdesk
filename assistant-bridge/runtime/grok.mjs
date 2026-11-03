import { setTimeout as delay } from 'node:timers/promises';
import { GrokBotClient, createLogin, pollLogin } from '../vendor/grok-bot-sdk/sdk.mjs';
import { API_ORIGIN, clientHeaders, requestJSON } from '../vendor/grok-bot-sdk/core.mjs';
import { fail, hash } from '../lib/util.mjs';

const ID = 'grok-direct';
const VERSION = '0.78.1';
const maxSeq = entries => entries.reduce((n,e) => BigInt(e.updatedSeq || e.seq || 0)>BigInt(n) ? String(e.updatedSeq || e.seq) : n,'0');
const authError = error => [401,403].includes(error?.httpStatus) || error?.code === 'ACCOUNT_AUTH_FAILED';
const messageFor = error => authError(error) ? 'Grok 登录已失效，请重新登录后恢复原任务。' : 'Grok 会话连接中断，已保留发送编号和读取位置。恢复不会重新发送任务。';

export function createGrokAdapter(options) {
  const {getSecret,setSecret,getConfig,setConfig} = options;
  const makeClient = options.makeClient || (opts => new GrokBotClient(opts));
  const fetchImpl = options.fetchImpl || fetch;
  const waits = options.pollMs ?? 4000;
  const settleMs = options.settleMs ?? 1000;
  const active = new Map(); let login = null; let closed = false; let verifiedAt = 0;
  let verifiedCredential = '', verifiedIdentity = '';
  const credentialKey = auth => hash(JSON.stringify([auth?.accessToken || '', auth?.teamId ?? null]));
  function accountIdentity(me, auth) {
    const id = me?.authId || me?.userId;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id)) fail(409, 'identity_unavailable', '无法确认 Grok 账号身份，请重新检查连接。');
    return hash(JSON.stringify(['grok', id, auth.teamId == null ? null : String(auth.teamId)]));
  }
  function credentials() {
    const value = getSecret('credentials');
    if (!value) return null;
    try { const parsed=JSON.parse(value);return typeof parsed.accessToken === 'string' ? parsed : null; } catch {return null;}
  }
  function client() {
    const auth=credentials();if(!auth)fail(409,'needs_login','请先登录 Grok 并选择原 Bot。');
    return makeClient({...auth,version:VERSION,fetchImpl});
  }
  function stateLogin() {
    if(login) return {state:login.state,url:login.state==='pending'?login.url:undefined,message:login.message,expiresAt:login.expiresAt};
    return {state:credentials()?'ready':'idle',message:credentials()?'Grok 已登录，可以选择原 Bot。':'点击登录，在官方页面完成验证。'};
  }
  async function checkStatus() {
    const base={id:ID,protocol:ID,name:'Grok 原 Bot',official:false,installed:true,version:VERSION};
    if(closed) return {...base,readiness:'unavailable',message:'Grok 连接已关闭。'};
    const auth=credentials();
    if(!auth) return {...base,readiness:'needs_login',message:'通过官方登录页授权；原 Bot 由社区协议连接器接入。'};
    let expired=false;
    try {const jwt=JSON.parse(Buffer.from(auth.accessToken.split('.')[1],'base64url').toString());expired=Number.isFinite(jwt.exp)&&jwt.exp*1000<Date.now()+30000;} catch {}
    if(expired) return {...base,readiness:'needs_login',message:'Grok 登录已过期，请重新登录。原 Bot 和历史不会被删除。'};
    const key = credentialKey(auth);
    if(Date.now()-verifiedAt>300000 || key !== verifiedCredential || !verifiedIdentity) {
      try {
        const me = await makeClient({...auth,version:VERSION,fetchImpl}).getMe();
        if(closed) return {...base,readiness:'unavailable',message:'Grok 连接已关闭。'};
        if (credentialKey(credentials()) !== key) return {...base,readiness:'connecting',message:'登录身份已变化，正在重新检查。'};
        verifiedIdentity=accountIdentity(me,auth);verifiedCredential=key;verifiedAt=Date.now();
      }
      catch(error) {
        if(closed) return {...base,readiness:'unavailable',message:'Grok 连接已关闭。'};
        if(credentialKey(credentials())!==key) return {...base,readiness:'connecting',message:'登录身份已变化，正在重新检查。'};
        return {...base,readiness:authError(error)?'needs_login':'unavailable',message:messageFor(error)};
      }
    }
    return {...base,readiness:'ready',connectionIdentity:verifiedIdentity,message:'已登录，可连接原 Bot 的现有会话。社区协议已对照官方客户端 0.78.1 验证。'};
  }
  async function loginAction(action) {
    if(action==='status')return stateLogin();
    if(action==='logout') {login?.controller?.abort();for(const controller of active.values())controller.abort();login=null;setSecret('credentials','');verifiedAt=0;verifiedCredential='';verifiedIdentity='';return stateLogin();}
    if(action==='cancel') {login?.controller?.abort();login=null;return stateLogin();}
    if(action!=='start')fail(400,'invalid_action','不支持的登录操作。');
    if(login?.state==='pending' && login.expiresAt>Date.now())return stateLogin();
    const flow=createLogin(),controller=new AbortController();
    const current={state:'pending',url:flow.loginUrl,message:'请在打开的官方页面登录，完成后此处会自动连接。',expiresAt:Date.now()+10*60*1000,controller};login=current;
    const timer=setTimeout(()=>controller.abort(),10*60*1000);timer.unref?.();
    const authFetch=(url,init={})=>fetchImpl(url,{...init,signal:init.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal});
    current.promise=pollLogin(flow,{fetchImpl:authFetch,maxAttempts:100,sleep:ms=>delay(ms,undefined,{signal:controller.signal})})
      .then(async result=>{
        if(controller.signal.aborted || login!==current || closed)return;
        const auth={accessToken:result.accessToken,refreshToken:result.refreshToken};
        const selectedTeam=result.selectedTeamId ?? result.teamId;
        if(selectedTeam!==undefined)auth.teamId=selectedTeam;
        const me = await makeClient({...auth,version:VERSION,fetchImpl}).getMe();
        const identity = accountIdentity(me,auth);
        if(controller.signal.aborted || login!==current || closed)return;
        setSecret('credentials',JSON.stringify(auth));setConfig({lastLoginAt:Date.now()});verifiedAt=Date.now();verifiedCredential=credentialKey(auth);verifiedIdentity=identity;
        current.state='ready';current.message='登录成功，请选择原 Bot。';
      }).catch(()=>{if(login===current&&!closed){current.state='failed';current.message='登录未完成或已过期，请点击重新登录。';}}).finally(()=>clearTimeout(timer));
    return stateLogin();
  }
  async function agents() {
    const data=await client().listBots();
    return {agents:data.bots.filter(b=>b.id).map(b=>({id:b.id,name:b.name||b.title||'Grok Bot',description:b.description||'',sessionId:b.sessionId||'',harness:b.harness||''})),truncated:data.truncated===true};
  }
  async function sessions({agentId}={}) {
    if(!agentId)return {sessions:[]};
    const result=await client().listSessions(agentId);
    return {sessions:result.sessions.map(s=>({id:s.sessionId,title:s.kind.includes('MAIN')?'主会话':(s.kind||'会话'),updatedAt:Number(s.lastActivityAtMs||s.updatedAtMs)||0}))};
  }
  async function monitor(run,emit,api,controller) {
    const data=run.runtimeData||{},botId=run.agentId,sessionId=run.sessionId||'';
    const baseline=data.baseline||{generation:0,afterUpdatedSeq:'0'};
    let cursor=run.cursor||'',latestSeq=baseline.afterUpdatedSeq,echoId=data.echoEntryId||'',echoSeq=data.echoSeq||'',seenRunning=data.seenRunning===true;
    let answerChangedAt=0,done=false,lastFreshIdle=0;
    const responses=new Map((run.messages||[]).filter(m=>m.role==='assistant').map(m=>[m.id,m.text]));
    const sentAt=data.sentAt||run.createdAt;
    function noteMessage(id,text,seq) {
      if(id===echoId||id===run.id||BigInt(seq||0)<=BigInt(echoSeq||baseline.afterUpdatedSeq))return;
      if(typeof text!=='string'||!text)return;
      if(responses.get(id)===text)return;
      responses.set(id,text);answerChangedAt=Date.now();
      emit({type:'message',id,role:'assistant',text});emit({type:'progress',text:'Grok 正在回复…'});
    }
    function noteLive(live) {
      if(!live)return;
      if(live.isRunning||live.isComposingMessage||live.isRetrying||live.hasRunningSubagents) {
        seenRunning=true;lastFreshIdle=0;emit({type:'checkpoint',data:{seenRunning:true}});
      } else {
        const updated=Number(live.updatedAtMs),stale=Number(live.staleAfterMs)||0;
        const validUntil=stale>1e12?stale:updated+stale;
        if(updated>=sentAt && (!stale||validUntil>Date.now()))lastFreshIdle=Date.now();
      }
    }
    async function finishIfReady() {
      if(!responses.size||!lastFreshIdle||(!seenRunning && !echoSeq))return;
      if(Date.now()-answerChangedAt<settleMs)return;
      done=true;emit({type:'complete',text:[...responses.values()].join('\n\n'),sessionId});controller.abort();
    }
    async function backfill() {
      const tail=await api.listTranscript({botId,sessionId,limit:200});
      if(tail.generation!==baseline.generation) {
        emit({type:'interrupted',message:'原 Bot 会话已被清空或切换，无法可靠关联这次结果。请查看原会话后重新安排。',deliveryStatus:run.deliveryStatus});done=true;controller.abort();return;
      }
      for(const entry of [...tail.entries].sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:1)) {
        if(BigInt(entry.updatedSeq||entry.seq)<=BigInt(baseline.afterUpdatedSeq))continue;
        const body=entry.body;
        if(body?.kind==='message'&&body.role==='user'&&(body.id===run.id||entry.entryId===echoId)){
          echoId=entry.entryId||body.id;echoSeq=String(entry.seq);emit({type:'checkpoint',data:{echoEntryId:echoId,echoSeq}});
        }
        if(body?.kind==='send-message'&&body.message?.type==='text')noteMessage(entry.entryId||body.id,body.message.content,entry.updatedSeq||entry.seq);
      }
      latestSeq=maxSeq(tail.entries);
    }
    const poll=async()=>{
      while(!controller.signal.aborted&&!done) {
        try {
          const delivery=await api.getSendStatus({botId,sessionId,messageId:run.id,firstSentAgeMs:Math.max(0,Date.now()-sentAt)});
          if(delivery.status==='rejected'){emit({type:'failed',message:'Grok 拒绝了这次消息，请检查原 Bot 状态。',deliveryStatus:'rejected'});done=true;controller.abort();return;}
          if(delivery.status==='accepted') {if(delivery.echoEntryId)echoId=delivery.echoEntryId;emit({type:'started',sessionId});emit({type:'checkpoint',data:{echoEntryId:echoId}});}
          const statuses=await api.listAgentStatuses([botId]);
          noteLive(statuses.statuses.find(s=>s.agentId===botId)?.live);
          // Backfill also covers a lost stream and an assistant reply that arrived before reconnect.
          await backfill();await finishIfReady();
        } catch(error) {if(authError(error)){emit({type:'interrupted',message:messageFor(error)});done=true;controller.abort();return;}}
        try {await delay(waits,undefined,{signal:controller.signal});}catch{return;}
      }
    };
    const polling=poll();let failures=0;
    try {
      while(!controller.signal.aborted&&!done) {
        try {
          for await(const event of api.watchBot({botId,sessionId,...cursor?{resumeFrom:cursor}:{cursor:{generation:baseline.generation,afterUpdatedSeq:latestSeq}},signal:controller.signal})) {
            if(controller.signal.aborted)break;
            if(event.id){cursor=event.id;emit({type:'checkpoint',cursor,data:{}});}
            if(event.type==='message')noteMessage(event.data.entryId||event.id,event.data.text,event.data.updatedSeq);
            else if(event.type==='entry' && event.data.entry?.kind==='tool-call')emit({type:'progress',text:'Grok 正在调用工具处理事项…'});
            else if(event.type==='agent.state')for(const live of event.data.live||[])noteLive(live);
            else if(event.type==='turn.failed'){emit({type:'failed',message:'Grok 报告本轮执行失败。已保留会话进度。'});done=true;controller.abort();break;}
            else if(event.type==='resync-required'){cursor='';await backfill();break;}
            else if(event.type==='reset'){emit({type:'interrupted',message:'原会话已被重置，请检查 Bot 会话后再继续。'});done=true;controller.abort();break;}
            await finishIfReady();
          }
          failures=0;
        }catch(error){
          if(controller.signal.aborted)break;
          if(authError(error)){emit({type:'interrupted',message:messageFor(error)});done=true;controller.abort();break;}
          failures++;emit({type:'progress',text:'正在恢复 Grok 会话连接…'});
          if(failures>=6){emit({type:'interrupted',message:messageFor(error)});done=true;controller.abort();break;}
        }
        if(!controller.signal.aborted)try{await delay(Math.min(1000*2**failures,15000),undefined,{signal:controller.signal});}catch{}
      }
    }finally{controller.abort();await polling;}
  }
  async function start(run,emit) {
    const controller=new AbortController();active.set(run.id,controller);
    let sent=false;
    try {
      const api=client(),roster=await api.listBots(),bot=roster.bots.find(b=>b.id===run.agentId);
      if(!bot){emit({type:'failed',message:'当前账号下找不到选定的 Bot，请重新选择。',deliveryStatus:'rejected'});return;}
      run.sessionId=run.sessionId||bot.sessionId||'';
      const existing=(await api.listAgentStatuses([run.agentId])).statuses.find(s=>s.agentId===run.agentId);
      if(existing?.isRunning||existing?.live?.isRunning||existing?.live?.isComposingMessage){emit({type:'failed',message:'这个原 Bot 正在处理其他工作，请等它完成后再派发，或选择另一位 Bot。',deliveryStatus:'rejected'});return;}
      const before=await api.listTranscript({botId:run.agentId,sessionId:run.sessionId,limit:1});
      const baseline={generation:before.generation,afterUpdatedSeq:maxSeq(before.entries)};
      const sentAt=Date.now();run.runtimeData={baseline,sentAt};
      emit({type:'checkpoint',sessionId:run.sessionId,turnId:run.id,data:run.runtimeData});
      const text=['事项：'+run.title,run.instruction,run.context?'交接资料：\n'+run.context:''].filter(Boolean).join('\n\n');
      emit({type:'message',id:run.id,role:'user',text,complete:true});
      sent=true;
      try {await api.sendMessage({botId:run.agentId,sessionId:run.sessionId,messageId:run.id,text});run.deliveryStatus='accepted';emit({type:'started',sessionId:run.sessionId,turnId:run.id});}
      catch(error){
        if(error.code==='SEND_REFUSED'){emit({type:'failed',message:'Grok 未接受这次派发，请检查 Bot 状态。',deliveryStatus:'rejected'});return;}
        run.deliveryStatus='unknown';emit({type:'interrupted',message:'暂时无法确认 Grok 是否收到消息，正在按原发送编号查询，不会重复发送。',deliveryStatus:'unknown'});
      }
      await monitor(run,emit,api,controller);
    }catch(error){emit({type:sent?'interrupted':'failed',message:messageFor(error),deliveryStatus:sent?'unknown':'rejected'});}
    finally{active.delete(run.id);}
  }
  async function recover(run,emit) {
    if(!run.runtimeData?.baseline){emit({type:'interrupted',message:'缺少原会话读取位置，为避免重复执行，请检查 Bot 原会话。'});return;}
    const controller=new AbortController();active.set(run.id,controller);
    try {await monitor(run,emit,client(),controller);}finally{active.delete(run.id);}
  }
  async function cancel(run) {
    let remoteStopped=false;
    try {
      const auth=credentials();
      if(auth) {
        const result=await requestJSON(API_ORIGIN+'/aiserver.v1.GrokBotService/InterruptGrokBotAgentRun',{headers:clientHeaders({...auth,version:VERSION}),body:{agentId:run.agentId,sessionId:run.sessionId||'',reason:'user_interrupt'},fetchImpl});
        remoteStopped=result.ok && typeof result.data?.hadActiveRun==='boolean';
      }
    }finally{active.get(run.id)?.abort();}
    return {remoteStopped};
  }
  return {id:ID,protocol:ID,status:checkStatus,login:loginAction,agents,sessions,start,recover,cancel,
    async close(){closed=true;login?.controller?.abort();for(const controller of active.values())controller.abort();},
  };
}
