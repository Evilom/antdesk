import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from './lib/store.mjs';
import { createAuth } from './lib/auth.mjs';
import { Events } from './lib/events.mjs';
import { Jobs } from './lib/jobs.mjs';
import { RuntimeManager } from './runtime/manager.mjs';
import { handleMcp } from './lib/mcp.mjs';
import { safeWebhookFetch, httpsUrl } from './lib/webhook.mjs';
import { BridgeError, bearer, equal, fail, identifier, json, random, readJson, string } from './lib/util.mjs';

/** The injected sender is only an in-process test seam, never a configuration flag. */
export async function createBridge({storePath,adminToken,publicUrl='',botTokens=[],webhookFetch=safeWebhookFetch,retryDelaysMs,projectRoot,toolsDir,runtimeAdapters,queueUrl='http://127.0.0.1:47833',queueRequest}={}) {
  string(storePath,'storePath',4096);string(adminToken,'adminToken',8192);if(adminToken.length<24)throw new Error('Use a random admin token with at least 24 characters.');
  if(publicUrl){const url=httpsUrl(publicUrl);if(url.search||url.pathname!=='/')throw new Error('publicUrl must be an HTTPS origin without a path or query.');publicUrl=url.origin;}
  const store=new Store(storePath,adminToken);
  const queueToken=createHash('sha256').update('antdesk-queue-v1\0'+adminToken).digest('base64url');
  const plannerRequest=queueRequest||(async(name,args)=>{
    let endpoint=queueUrl;
    const discovery=path.join(path.dirname(storePath),'planner-endpoint.json');
    if(fs.existsSync(discovery)){
      try{
        if(fs.statSync(discovery).size>1024)throw new Error('oversized');
        const value=JSON.parse(fs.readFileSync(discovery,'utf8'));
        if(value.version!==1||typeof value.url!=='string')throw new Error('invalid');
        endpoint=value.url;
      }catch{throw new BridgeError(503,'queue_unavailable','The desktop queue discovery is invalid. Reopen AntDesk.');}
    }
    let url;try{url=new URL(endpoint);}catch{throw new BridgeError(503,'queue_unavailable','The desktop queue endpoint is invalid.');}
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new BridgeError(503,'queue_unavailable','The desktop queue must use a loopback endpoint.');
    let response;try{response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-antdesk-queue-token':queueToken},body:JSON.stringify({name,arguments:args}),redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw new BridgeError(503,'queue_unavailable','The desktop planner is unavailable. Reopen AntDesk and try again.');}
    let value;try{value=await response.json();}catch{throw new BridgeError(503,'queue_unavailable','The desktop planner returned an invalid response.');}
    if(value?.service!=='antdesk-planner'||value?.version!==1)throw new BridgeError(503,'queue_unavailable','The desktop planner returned an incompatible response.');
    if(!response.ok)throw new BridgeError([400,409].includes(response.status)?response.status:503,value.error?.code==='queue_conflict'?'queue_conflict':'queue_unavailable',typeof value.error?.message==='string'?value.error.message.slice(0,1000):'The planner could not update the queue.');
    if(!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.tasks))throw new BridgeError(503,'queue_unavailable','The desktop planner returned an invalid queue.');
    return value;
  });
  // A private tunnel can call only the original Dot's MCP queue. It never gets
  // the desktop's administrative token or another assistant's credentials.
  let dotsMcpToken;
  try {
    const saved=store.data.runtime?.providers?.['dots-direct']?.secrets?.mcpToken;
    dotsMcpToken=saved?store.unseal(saved):random(32);
    if(!saved)store.commit(s=>{s.runtime??={providers:{}};const p=s.runtime.providers['dots-direct']??={config:{},secrets:{}};p.secrets??={};p.secrets.mcpToken=store.seal(dotsMcpToken);});
  } catch(error){store.close();throw error;}
  let auth;try {auth=createAuth({store,adminToken,publicUrl,botTokens:[...botTokens,{agentId:'omdot-events',token:dotsMcpToken}]});}catch(error){store.close();throw error;}
  const events=new Events({store,webhookFetch,retryDelaysMs,isPrincipalActive:id=>auth.isPrincipalActive(id)});
  const jobs=new Jobs({store,events,webhookFetch,publicUrl});
  let baseUrl='',closed=false;
  const runtimes=new RuntimeManager({store,projectRoot,toolsDir,adapters:runtimeAdapters,events,getDotsUpstream:()=>({url:baseUrl+'/mcp',token:dotsMcpToken})});
  const server=http.createServer(async(req,res)=>{
    try {
      const host=req.headers.host||'';const localOrigin=baseUrl?new URL(baseUrl):null;
      const allowedHosts=new Set([localOrigin?.host,publicUrl?new URL(publicUrl).host:null].filter(Boolean));
      if(localOrigin) {allowedHosts.add('localhost:'+localOrigin.port);allowedHosts.add('127.0.0.1:'+localOrigin.port);allowedHosts.add('[::1]:'+localOrigin.port);}
      if(!allowedHosts.has(host))fail(421,'invalid_host','Unexpected Host header.');
      const origin=req.headers.origin;
      if(origin&&origin!==publicUrl&&origin!==baseUrl)fail(403,'invalid_origin','This origin is not allowed.');
      const url=new URL(req.url,publicUrl||baseUrl);
      if(await auth.handle(req,res,url))return;
      if(url.pathname==='/health'&&req.method==='GET')return json(res,200,{service:'antdesk-native-bridge',version:1,runtimeVersion:1,capabilities:['official-mcp','assistant-runtimes']});
      if(url.pathname==='/mcp'){
        const principal=auth.authenticate(bearer(req));
        if(!principal)return json(res,401,{error:{code:'unauthorized',message:'Connect this assistant with OAuth or a scoped token.'}},{'WWW-Authenticate':'Bearer resource_metadata="'+(publicUrl||baseUrl)+'/.well-known/oauth-protected-resource/mcp"'});
        if(req.method!=='POST')return json(res,405,{error:{code:'method_not_allowed',message:'Use stateless Streamable HTTP POST requests.'}},{Allow:'POST'});
        if(!(req.headers['content-type']||'').includes('application/json'))fail(415,'content_type','Use application/json.');
        const request=await readJson(req);
        // Tunnel's local discovery probe is not evidence that ChatGPT can
        // reach this connection. Only forwarded, authenticated requests count.
        if(req.headers['x-antdesk-discovery']!=='1'){
          const previous=store.data.agents[principal.agentId];
          const method=['initialize','server/discover','ping','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe'].includes(request.method)?request.method:'other';
          if(!previous?.lastSeenAt||Date.now()-previous.lastSeenAt>1000||previous.mcpActivity?.method!==method)store.commit(s=>{
            // Method names and protocol versions diagnose connectivity without
            // retaining callback URLs, credentials, task content or arguments.
            s.agents[principal.agentId]={...s.agents[principal.agentId],lastSeenAt:Date.now(),principalId:principal.principalId,
              mcpActivity:{method,at:Date.now(),protocolVersion:typeof req.headers['mcp-protocol-version']==='string'?req.headers['mcp-protocol-version'].slice(0,40):'',methodHeader:req.headers['mcp-method']===request.method?'match':req.headers['mcp-method']?'mismatch':'absent'}};
          });
        }
        return await handleMcp(req,res,request,principal,{jobs,events,queueRequest:plannerRequest});
      }
      if(url.pathname.startsWith('/api/')){
        if(!equal(bearer(req),adminToken))fail(401,'unauthorized','A desktop bridge token is required.');
        if(req.method==='GET'&&url.pathname==='/api/status'){
          const protocol=url.searchParams.get('protocol'),agentId=url.searchParams.get('agentId');
          return json(res,200,runtimes.owns(protocol)?await runtimes.status(agentId,protocol):jobs.status(agentId,protocol));
        }
        if(req.method==='GET'&&url.pathname==='/api/runtime/providers')return json(res,200,await runtimes.providers());
        const providerRoute=/^\/api\/runtime\/providers\/([a-z-]+)\/(agents|sessions|configure|logout|login\/(?:start|status|cancel))$/.exec(url.pathname);
        if(providerRoute){
          const [,provider,action]=providerRoute;
          const method=['agents','sessions','login/status'].includes(action)?'GET':'POST';
          if(req.method!==method)fail(405,'method_not_allowed','Unsupported method.');
          if(method==='POST'&&!(req.headers['content-type']||'').includes('application/json'))fail(415,'content_type','Use application/json.');
          const body=method==='POST'?await readJson(req):{};
          return json(res,200,await runtimes.providerAction(provider,action,body,Object.fromEntries(url.searchParams)));
        }
        const responseRoute=/^\/api\/runtime\/runs\/([^/]+)\/respond$/.exec(url.pathname);
        if(responseRoute&&req.method==='POST'){
          if(!(req.headers['content-type']||'').includes('application/json'))fail(415,'content_type','Use application/json.');
          return json(res,200,await runtimes.respond(identifier(decodeURIComponent(responseRoute[1])),await readJson(req)));
        }
        if(req.method==='POST'&&url.pathname==='/api/runs'){
          if(!(req.headers['content-type']||'').includes('application/json'))fail(415,'content_type','Use application/json.');
          const input=await readJson(req);const {created,run}=runtimes.owns(input.protocol)?await runtimes.create(input):jobs.create(input);return json(res,created?202:200,run);
        }
        const match=/^\/api\/runs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
        if(match){const id=identifier(decodeURIComponent(match[1]));if(req.method==='GET'&&!match[2])return json(res,200,runtimes.ownsRun(id)?runtimes.get(id):jobs.get(id));if(req.method==='POST'&&match[2])return json(res,200,runtimes.ownsRun(id)?await runtimes.cancel(id):jobs.cancel(id));}
      }
      fail(404,'not_found','No such bridge endpoint.');
    }catch(error){if(res.headersSent){res.end();return;}const known=error instanceof BridgeError;json(res,known?error.status:500,{error:{code:known?error.code:'internal_error',message:known?error.message:'The bridge could not complete this request.'}},known?error.headers||{}:{});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
  const bridge={server,state:store, get baseUrl(){return baseUrl;},
    async listen(port=0,host='127.0.0.1'){
      if(!['127.0.0.1','::1','localhost'].includes(host)&&!publicUrl)throw new Error('A public HTTPS origin is required before binding a non-loopback interface.');
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
      const address=server.address();const urlHost=host==='::1'?'[::1]':host==='0.0.0.0'?'127.0.0.1':host;baseUrl='http://'+urlHost+':'+address.port;events.start();
      if(store.data.runtime?.providers?.['dots-direct']?.config?.tunnelEnabled===true)void runtimes.adapter('dots-direct').then(adapter=>adapter.resume?.()).catch(()=>{});
      return baseUrl;
    },
    async close(){if(closed)return;closed=true;await events.close();await jobs.close();await runtimes.close();if(server.listening){const closing=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();await closing;}store.close();},
  };
  return bridge;
}
