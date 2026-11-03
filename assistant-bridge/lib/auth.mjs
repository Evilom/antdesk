import {createHash} from 'node:crypto';
import {BridgeError,bearer,equal,escapeHtml,fail,hash,identifier,json,random,readBody,readJson} from './util.mjs';

const SCOPE='antdesk:tasks', ACCESS_MS=60*60*1000, REFRESH_MS=30*24*60*60*1000;
const AUTHORIZATION_MS=10*60*1000, CODE_MS=2*60*1000;
const oauthError=(status,error,description)=>Object.assign(new Error(description),{oauth:true,status,error});
const denied=(error,description,status=400)=>{throw oauthError(status,error,description);};
const pkce=value=>createHash('sha256').update(value).digest('base64url');
const validVerifier=value=>typeof value==='string'&&/^[A-Za-z0-9._~-]{43,128}$/.test(value);
const nowSeconds=ms=>Math.floor(ms/1000);

function publicBase(value){
  if(!value)return '';
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('OAuth publicUrl must be an HTTPS URL without credentials, query or fragment.');
  return url.href.replace(/\/+$/,'');
}
function redirectUri(value){
  if(typeof value!=='string'||value.length>2048)denied('invalid_client_metadata','A valid redirect URI is required.');
  let url;try{url=new URL(value);}catch{denied('invalid_client_metadata','A valid redirect URI is required.');}
  const local=url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.hash)denied('invalid_client_metadata','Redirects require HTTPS or a literal loopback HTTP address and cannot contain credentials or fragments.');
  return url.href;
}
function parameters(input){
  const values={};
  for(const [key,value]of input){
    if(Object.hasOwn(values,key))denied('invalid_request','Duplicate request parameters are not accepted.');
    if(value.length>8192)denied('invalid_request','Request parameter is too long.');
    values[key]=value;
  }
  return values;
}
async function form(req){
  if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))denied('invalid_request','Use application/x-www-form-urlencoded.');
  return parameters(new URLSearchParams(await readBody(req,24*1024)));
}
function cookies(req){
  const values={};
  for(const part of (req.headers.cookie||'').split(';')){
    const at=part.indexOf('=');if(at<0)continue;
    const name=part.slice(0,at).trim(),value=part.slice(at+1).trim();
    if(Object.hasOwn(values,name))values[name]='';else values[name]=value;
  }
  return values;
}
function clean(state,now){
  for(const [key,value]of Object.entries(state.oauth.approvals))if(value.expiresAt<=now)delete state.oauth.approvals[key];
  for(const [key,value]of Object.entries(state.oauth.codes))if(value.expiresAt<=now)delete state.oauth.codes[key];
  for(const collection of ['tokens','refresh'])for(const [key,value]of Object.entries(state.oauth[collection]))if(value.expiresAt<=now)delete state.oauth[collection][key];
  for(const [key,value]of Object.entries(state.oauth.grants))if(value.expiresAt<=now)delete state.oauth.grants[key];
}
function revokeGrant(state,id,now){
  const grant=state.oauth.grants[id];if(grant)grant.revokedAt=now;
  for(const collection of ['tokens','refresh'])for(const value of Object.values(state.oauth[collection]))if(value.principalId===id)value.revokedAt=now;
  for(const sub of Object.values(state.subscriptions||{}))if(sub.principalId===id)sub.active=false;
}

export class Auth{
  constructor({store,adminToken,publicUrl='',botTokens=[],clock=Date.now}){
    if(typeof adminToken!=='string'||adminToken.length<24)throw new Error('A strong bridge administrator token is required.');
    this.store=store;this.clock=clock;this.adminHash=hash(adminToken);
    this.issuer=publicBase(publicUrl);this.resourceUrl=this.issuer?this.issuer+'/mcp':'';
    this.basePath=this.issuer?new URL(this.issuer).pathname.replace(/\/$/,''):'';
    this.direct=new Map();this.directPrincipals=new Set();
    for(const item of botTokens){
      identifier(item.agentId,'agentId');
      if(item.agentId.length>128||typeof item.token!=='string'||item.token.length<24)throw new Error('Each bot token needs an agent identity and a strong token.');
      const digest=hash(item.token);if(equal(digest,this.adminHash)||this.direct.has(digest))throw new Error('Bot and administrator credentials must be distinct.');
      const principal={agentId:item.agentId,principalId:'bot:'+digest};
      this.direct.set(digest,principal);this.directPrincipals.add(principal.principalId);
    }
    this.store.commit(state=>{
      state.oauth??={};for(const key of ['clients','codes','tokens','refresh','approvals','grants'])state.oauth[key]??={};
      clean(state,this.clock());
    });
  }
  authenticate(token){
    if(typeof token!=='string'||!token||token.length>8192)return null;
    const digest=hash(token),direct=this.direct.get(digest);
    if(direct)return {...direct};
    const value=this.store.data.oauth.tokens[digest],now=this.clock();
    if(!value||value.revokedAt!==undefined||value.expiresAt<=now||value.resource!==this.resourceUrl)return null;
    const grant=this.store.data.oauth.grants[value.principalId];
    if(!grant||grant.revokedAt!==undefined||grant.expiresAt<=now||grant.resource!==this.resourceUrl||grant.agentId!==value.agentId)return null;
    return {agentId:value.agentId,principalId:value.principalId};
  }
  isPrincipalActive(principalId){
    if(this.directPrincipals.has(principalId))return true;
    const now=this.clock(),grant=this.store.data.oauth.grants[principalId];
    if(!grant||grant.revokedAt!==undefined||grant.expiresAt<=now||grant.resource!==this.resourceUrl)return false;
    return ['tokens','refresh'].some(name=>Object.values(this.store.data.oauth[name]).some(value=>value.principalId===principalId&&value.revokedAt===undefined&&value.usedAt===undefined&&value.expiresAt>now&&value.resource===this.resourceUrl));
  }
  get challenge(){
    if(!this.issuer)return 'Bearer realm="AntDesk"';
    const issuer=new URL(this.issuer);
    const metadata=issuer.origin+'/.well-known/oauth-protected-resource'+this.basePath+'/mcp';
    return 'Bearer resource_metadata="'+metadata+'", scope="'+SCOPE+'"';
  }
  principal(req){
    const value=this.authenticate(bearer(req));
    if(!value){const error=new BridgeError(401,'unauthorized','An authorized assistant connection is required.');error.headers={'WWW-Authenticate':this.challenge};throw error;}
    return value;
  }
  admin(req){
    if(!equal(hash(bearer(req)),this.adminHash))fail(401,'unauthorized','Administrator authentication is required.');
    return {principalId:'admin',role:'admin'};
  }
  resourceMetadata(){
    return {resource:this.resourceUrl,resource_name:'AntDesk private assistant tasks',authorization_servers:[this.issuer],scopes_supported:[SCOPE],bearer_methods_supported:['header']};
  }
  authorizationMetadata(){
    return {issuer:this.issuer,authorization_endpoint:this.issuer+'/oauth/authorize',token_endpoint:this.issuer+'/oauth/token',
      registration_endpoint:this.issuer+'/oauth/register',revocation_endpoint:this.issuer+'/oauth/revoke',
      response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],
      code_challenge_methods_supported:['S256'],scopes_supported:[SCOPE],response_modes_supported:['query'],
      authorization_response_iss_parameter_supported:true};
  }
  async register(req,res){
    const data=await readJson(req);
    if(!Array.isArray(data.redirect_uris)||!data.redirect_uris.length||data.redirect_uris.length>8)denied('invalid_client_metadata','Provide one to eight redirect URIs.');
    if(data.token_endpoint_auth_method&&data.token_endpoint_auth_method!=='none')denied('invalid_client_metadata','This server supports public clients with PKCE and token_endpoint_auth_method none.');
    if(data.grant_types&&(!Array.isArray(data.grant_types)||data.grant_types.some(v=>!['authorization_code','refresh_token'].includes(v))))denied('invalid_client_metadata','Unsupported grant type.');
    if(data.response_types&&(!Array.isArray(data.response_types)||data.response_types.some(v=>v!=='code')))denied('invalid_client_metadata','Only the authorization code response type is supported.');
    const name=typeof data.client_name==='string'?data.client_name.trim():'MCP client';
    if(!name||name.length>120)denied('invalid_client_metadata','Client name is invalid.');
    const uris=[...new Set(data.redirect_uris.map(redirectUri))],clientId='antdesk_'+random(24),now=this.clock();
    this.store.commit(state=>{
      if(Object.keys(state.oauth.clients).length>=256)denied('temporarily_unavailable','Client registration capacity has been reached.',503);
      state.oauth.clients[clientId]={clientId,name,redirectUris:uris,createdAt:now};
    });
    json(res,201,{client_id:clientId,client_id_issued_at:nowSeconds(now),client_name:name,redirect_uris:uris,
      token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:SCOPE});
  }
  authorizationRequest(params){
    const client=this.store.data.oauth.clients[params.client_id];
    if(!client)denied('invalid_client','Unknown client.',400);
    let redirect;try{redirect=redirectUri(params.redirect_uri);}catch{denied('invalid_request','Redirect URI is invalid.');}
    if(!client.redirectUris.includes(redirect))denied('invalid_request','Redirect URI is not registered.');
    if(params.response_type!=='code')denied('unsupported_response_type','Only response_type code is supported.');
    if(params.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge||''))denied('invalid_request','A PKCE S256 challenge is required.');
    if(params.resource!==this.resourceUrl)denied('invalid_target','The resource must be the advertised AntDesk MCP URL.');
    if(params.scope&&params.scope!==SCOPE)denied('invalid_scope','Only the advertised task scope can be granted.');
    if(params.state&&params.state.length>2048)denied('invalid_request','State is too long.');
    return {clientId:client.clientId,redirectUri:redirect,challenge:params.code_challenge,resource:this.resourceUrl,scope:SCOPE,state:params.state||''};
  }
  async authorizeGet(req,res,url){
    const authorization=this.authorizationRequest(parameters(url.searchParams));
    const client=this.store.data.oauth.clients[authorization.clientId],now=this.clock();
    const approvalId=random(24),csrf=random(32),browser=random(32),cookieName='antdesk_oauth_'+approvalId.slice(0,16);
    this.store.commit(state=>{
      clean(state,now);
      if(Object.keys(state.oauth.approvals).length>=256)denied('temporarily_unavailable','Too many pending authorization requests.',503);
      state.oauth.approvals[hash(approvalId)]={...authorization,csrfHash:hash(csrf),browserHash:hash(browser),cookieName,expiresAt:now+AUTHORIZATION_MS,attempts:0};
    });
    const options=[...new Set([...this.direct.values()].map(v=>v.agentId).concat(Object.keys(this.store.data.agents||{})))].slice(0,50)
      .map(id=>'<option value="'+escapeHtml(id)+'"></option>').join('');
    const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 AntDesk 助理</title>'+
      '<style>body{margin:0;background:#11151d;color:#edf3ff;font:16px/1.6 system-ui,sans-serif}main{max-width:480px;margin:8vh auto;padding:30px;background:#1b2230;border:1px solid #354056;border-radius:18px}h1{font-size:24px}small,p{color:#b6c5dc}label{display:block;margin-top:18px}input{box-sizing:border-box;width:100%;padding:12px;background:#111827;color:#fff;border:1px solid #53627a;border-radius:9px;font:inherit}button{padding:11px 20px;margin:22px 12px 0 0;border:0;border-radius:9px;font:inherit;cursor:pointer}button[value=allow]{background:#b6d3ff;color:#13223a}code{overflow-wrap:anywhere;font-size:13px}</style>'+
      '<main><h1>连接你的 AntDesk 助理</h1><p>应用 <strong>'+escapeHtml(client.name)+'</strong> 请求访问分配给指定助理的事项，并回写进度与结果。</p>'+
      '<p>回调地址：<code>'+escapeHtml(authorization.redirectUri)+'</code></p><form method="post" action="'+escapeHtml(this.issuer+'/oauth/authorize')+'">'+
      '<input type="hidden" name="approval_id" value="'+approvalId+'"><input type="hidden" name="csrf" value="'+csrf+'">'+
      '<label for="agent">助理标识</label><input id="agent" name="agent_id" list="agents" required maxlength="128" autocomplete="off" placeholder="与 AntDesk 中的助理标识一致"><datalist id="agents">'+options+'</datalist>'+
      '<label for="admin">AntDesk 桥接管理员密钥</label><input id="admin" name="admin_token" type="password" required maxlength="8192" autocomplete="off">'+
      '<small>授权仅用于这个助理；管理员密钥不会交给该应用。</small><div><button name="decision" value="allow">允许连接</button><button name="decision" value="deny" formnovalidate>取消</button></div></form></main></html>';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Set-Cookie':cookieName+'='+browser+'; Path='+(this.basePath||'')+'/oauth/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=600'});
    res.end(html);
  }
  async authorizePost(req,res){
    const input=await form(req),now=this.clock(),key=hash(input.approval_id||'');
    const approval=this.store.data.oauth.approvals[key];
    if(!approval||approval.expiresAt<=now)denied('invalid_request','Authorization request expired. Start again.');
    if(req.headers.origin&&req.headers.origin!==new URL(this.issuer).origin)denied('invalid_request','Authorization origin is invalid.');
    if(!equal(hash(input.csrf||''),approval.csrfHash)||!equal(hash(cookies(req)[approval.cookieName]||''),approval.browserHash))denied('invalid_request','Authorization form verification failed.');
    const location=new URL(approval.redirectUri);
    location.searchParams.set('iss',this.issuer);
    if(approval.state)location.searchParams.set('state',approval.state);
    if(input.decision==='deny'){
      this.store.commit(state=>{delete state.oauth.approvals[key];});
      location.searchParams.set('error','access_denied');
    }else{
      if(input.decision!=='allow')denied('invalid_request','Explicit approval is required.');
      if(!equal(hash(input.admin_token||''),this.adminHash)){
        this.store.commit(state=>{const current=state.oauth.approvals[key];if(current&&++current.attempts>=5)delete state.oauth.approvals[key];});
        denied('access_denied','Administrator authentication failed.',401);
      }
      try{identifier(input.agent_id,'agent_id');}catch{denied('invalid_request','Choose a valid assistant identity.');}
      if(input.agent_id.length>128)denied('invalid_request','Assistant identity is too long.');
      const code=random(32);
      this.store.commit(state=>{
        const current=state.oauth.approvals[key];
        if(!current||current.expiresAt<=now)denied('invalid_request','Authorization request expired.');
        state.oauth.codes[hash(code)]={...current,agentId:input.agent_id,expiresAt:now+CODE_MS};
        delete state.oauth.approvals[key];
      });
      location.searchParams.set('code',code);
    }
    res.writeHead(302,{Location:location.href,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
      'Set-Cookie':approval.cookieName+'=; Path='+(this.basePath||'')+'/oauth/authorize; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});
    res.end();
  }
  issue(state,grant,now){
    clean(state,now);
    if(Object.keys(state.oauth.tokens).length>=8192||Object.keys(state.oauth.refresh).length>=8192)denied('temporarily_unavailable','Token capacity has been reached.',503);
    const access=random(32),refresh=random(32);
    const record={principalId:grant.principalId,clientId:grant.clientId,agentId:grant.agentId,resource:grant.resource,scope:grant.scope,createdAt:now};
    const expiry=Math.min(now+ACCESS_MS,grant.expiresAt);
    state.oauth.tokens[hash(access)]={...record,expiresAt:expiry};
    state.oauth.refresh[hash(refresh)]={...record,expiresAt:grant.expiresAt};
    return {access_token:access,token_type:'Bearer',expires_in:Math.max(0,Math.floor((expiry-now)/1000)),refresh_token:refresh,scope:grant.scope};
  }
  async token(req,res){
    const input=await form(req),now=this.clock();
    if(!this.store.data.oauth.clients[input.client_id])denied('invalid_client','Client authentication failed.',401);
    if(input.client_secret||req.headers.authorization)denied('invalid_client','This public client must use its client_id and PKCE.',401);
    if(input.resource!==this.resourceUrl)denied('invalid_target','The resource must match the advertised AntDesk MCP URL.');
    let output;
    if(input.grant_type==='authorization_code'){
      const key=hash(input.code||''),record=this.store.data.oauth.codes[key];
      if(!record||record.expiresAt<=now||record.clientId!==input.client_id||record.redirectUri!==input.redirect_uri||record.resource!==input.resource||!validVerifier(input.code_verifier)||!equal(pkce(input.code_verifier),record.challenge))denied('invalid_grant','Authorization code, redirect, audience or verifier is invalid.');
      if(record.usedAt!==undefined){
        if(record.principalId)this.store.commit(state=>revokeGrant(state,record.principalId,now));
        denied('invalid_grant','Authorization code has already been used.');
      }
      output=this.store.commit(state=>{
        const principalId='oauth:'+random(24);
        const grant={principalId,clientId:record.clientId,agentId:record.agentId,resource:record.resource,scope:record.scope,createdAt:now,expiresAt:now+REFRESH_MS};
        state.oauth.grants[principalId]=grant;state.oauth.codes[key].usedAt=now;state.oauth.codes[key].principalId=principalId;
        return this.issue(state,grant,now);
      });
    }else if(input.grant_type==='refresh_token'){
      const key=hash(input.refresh_token||''),record=this.store.data.oauth.refresh[key];
      if(!record||record.clientId!==input.client_id||record.resource!==input.resource||record.expiresAt<=now)denied('invalid_grant','Refresh token is invalid or expired.');
      if(record.usedAt!==undefined||record.revokedAt!==undefined){
        this.store.commit(state=>revokeGrant(state,record.principalId,now));
        denied('invalid_grant','Refresh token was already used or revoked.');
      }
      if(input.scope&&input.scope!==record.scope)denied('invalid_scope','The granted scope cannot be expanded.');
      const grant=this.store.data.oauth.grants[record.principalId];
      if(!grant||grant.revokedAt!==undefined||grant.expiresAt<=now)denied('invalid_grant','The authorization grant is expired or revoked.');
      output=this.store.commit(state=>{state.oauth.refresh[key].usedAt=now;return this.issue(state,grant,now);});
    }else denied('unsupported_grant_type','Unsupported grant type.');
    json(res,200,output,{'Pragma':'no-cache'});
  }
  async revoke(req,res){
    const input=await form(req);
    if(!this.store.data.oauth.clients[input.client_id])denied('invalid_client','Client authentication failed.',401);
    if(input.client_secret||req.headers.authorization)denied('invalid_client','Use the registered public client ID.',401);
    const digest=hash(input.token||''),oauth=this.store.data.oauth;
    const record=oauth.tokens[digest]||oauth.refresh[digest];
    if(record&&record.clientId===input.client_id)this.store.commit(state=>revokeGrant(state,record.principalId,this.clock()));
    // RFC 7009 does not disclose whether an unknown token existed.
    res.writeHead(200,{'Cache-Control':'no-store'});res.end();
  }
  async handle(req,res,url){
    let pathname=url.pathname;
    if(this.basePath&&pathname.startsWith(this.basePath+'/'))pathname=pathname.slice(this.basePath.length);
    const protectedPaths=new Set(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource'+this.basePath+'/mcp']);
    const authorizationPaths=new Set(['/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server'+this.basePath]);
    const known=protectedPaths.has(pathname)||authorizationPaths.has(pathname)||['/oauth/register','/oauth/authorize','/oauth/token','/oauth/revoke'].includes(pathname);
    if(!known)return false;
    try{
      // Static Bearer authentication intentionally has no OAuth metadata. The
      // official Tunnel treats unknown metadata as no-auth; a 503 keeps it degraded.
      if(!this.issuer)denied('invalid_request','OAuth is not configured for this bridge.',404);
      if(protectedPaths.has(pathname)&&req.method==='GET'){
        if(this.issuer){json(res,200,this.resourceMetadata());return true;}
        // No OAuth issuer means static-Bearer/no-auth for the official Tunnel.
        // An empty-resource metadata document is malformed and blocks startup.
        denied('invalid_request','OAuth is not configured for this bridge.',404);
      }
      if(authorizationPaths.has(pathname)&&req.method==='GET'){json(res,200,this.authorizationMetadata());return true;}
      if(pathname==='/oauth/register'&&req.method==='POST')await this.register(req,res);
      else if(pathname==='/oauth/authorize'&&req.method==='GET')await this.authorizeGet(req,res,url);
      else if(pathname==='/oauth/authorize'&&req.method==='POST')await this.authorizePost(req,res);
      else if(pathname==='/oauth/token'&&req.method==='POST')await this.token(req,res);
      else if(pathname==='/oauth/revoke'&&req.method==='POST')await this.revoke(req,res);
      else denied('invalid_request','HTTP method is not allowed.',405);
    }catch(error){
      const status=error.oauth?error.status:error instanceof BridgeError?error.status:500;
      const code=error.oauth?error.error:status===413?'invalid_request':status===500?'server_error':'invalid_request';
      const message=error.oauth?error.message:status===500?'Authorization could not be completed.':'The authorization request is invalid.';
      json(res,status,{error:code,error_description:message});
    }
    return true;
  }
  route(req,res,url){return this.handle(req,res,url);}
}

export const createAuth=options=>new Auth(options);
