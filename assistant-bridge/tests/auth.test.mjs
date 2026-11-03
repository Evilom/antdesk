import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Auth,createAuth} from '../lib/auth.mjs';
import {Store} from '../lib/store.mjs';

const ADMIN='local-test-admin-credential-0123456789',BOT='local-test-direct-bot-credential-012345';
const ISSUER='https://antdesk.example.test',RESOURCE=ISSUER+'/mcp',REDIRECT='https://client.example.test/oauth/callback';
class MemoryStore{
  constructor(){this.data={oauth:{clients:{},codes:{},tokens:{},refresh:{},approvals:{}},agents:{},subscriptions:{}};}
  commit(fn){const state=structuredClone(this.data),result=fn(state);this.data=state;return result;}
}
function fixture(options={}){
  let now=1_800_000_000_000;
  const store=options.store||new MemoryStore();
  const auth=createAuth({store,adminToken:ADMIN,publicUrl:ISSUER,botTokens:[{agentId:'grokbot',token:BOT}],clock:()=>now,...options});
  return {auth,store,advance:ms=>{now+=ms;}};
}
async function call(auth,method,path,body,headers={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(typeof body==='string'?body:JSON.stringify(body))]);
  req.method=method;req.url=path;req.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
  const res={status:0,headers:{},body:'',writeHead(status,head={}){this.status=status;this.headers=Object.fromEntries(Object.entries(head).map(([k,v])=>[k.toLowerCase(),v]));},end(body=''){this.body+=body;}};
  const handled=await auth.handle(req,res,new URL(path,ISSUER));
  return {...res,handled,json:()=>JSON.parse(res.body)};
}
const formCall=(auth,path,body,headers={})=>call(auth,'POST',path,new URLSearchParams(body).toString(),{'content-type':'application/x-www-form-urlencoded',...headers});
async function register(auth,name='My personal bot'){
  const response=await call(auth,'POST','/oauth/register',{client_name:name,redirect_uris:[REDIRECT],token_endpoint_auth_method:'none'},{'content-type':'application/json'});
  assert.equal(response.status,201,response.body);
  return response.json().client_id;
}
async function approval(auth,clientId,extra={}){
  const verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
  const params={response_type:'code',client_id:clientId,redirect_uri:REDIRECT,resource:RESOURCE,scope:'antdesk:tasks',state:'my-client-state',code_challenge:challenge,code_challenge_method:'S256',...extra};
  const response=await call(auth,'GET','/oauth/authorize?'+new URLSearchParams(params));
  if(response.status!==200)return {response,verifier,params};
  const approvalId=/name="approval_id" value="([^"]+)"/.exec(response.body)[1];
  const csrf=/name="csrf" value="([^"]+)"/.exec(response.body)[1];
  const cookie=response.headers['set-cookie'].split(';')[0];
  return {response,verifier,params,approvalId,csrf,cookie};
}
async function grant(auth,clientId,agentId='gptdot'){
  const approved=await approval(auth,clientId);
  assert.equal(approved.response.status,200,approved.response.body);
  const result=await formCall(auth,'/oauth/authorize',{approval_id:approved.approvalId,csrf:approved.csrf,agent_id:agentId,admin_token:ADMIN,decision:'allow'},{cookie:approved.cookie,origin:ISSUER});
  assert.equal(result.status,302,result.body);
  const callback=new URL(result.headers.location);
  assert.equal(callback.origin,new URL(REDIRECT).origin);
  assert.equal(callback.searchParams.get('state'),'my-client-state');
  assert.equal(callback.searchParams.get('iss'),ISSUER);
  return {...approved,code:callback.searchParams.get('code')};
}
const exchange=(auth,clientId,grant,extra={})=>formCall(auth,'/oauth/token',{grant_type:'authorization_code',client_id:clientId,code:grant.code,redirect_uri:REDIRECT,resource:RESOURCE,code_verifier:grant.verifier,...extra});

test('metadata advertises PKCE, DCR and the exact MCP audience; offline bridge does not invent an issuer',async()=>{
  const {auth}=fixture();
  const resource=(await call(auth,'GET','/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource,RESOURCE);assert.deepEqual(resource.authorization_servers,[ISSUER]);
  const metadata=(await call(auth,'GET','/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  assert.equal(metadata.registration_endpoint,ISSUER+'/oauth/register');
  assert.equal(metadata.authorization_response_iss_parameter_supported,true);
  const offline=fixture({publicUrl:''}).auth;
  assert.equal((await call(offline,'GET','/.well-known/oauth-authorization-server')).status,404);
  assert.equal(offline.authenticate(BOT).agentId,'grokbot');
  assert.equal((await call(auth,'GET','/not-an-auth-route')).handled,false);
});

test('direct bot identities are scoped and hashed; admin key is never a bot credential',()=>{
  const {auth,store}=fixture();
  const principal=auth.authenticate(BOT);
  assert.equal(principal.agentId,'grokbot');assert.ok(principal.principalId.startsWith('bot:'));
  assert.equal(auth.authenticate(ADMIN),null);assert.equal(auth.authenticate('unknown'),null);
  assert.equal(auth.isPrincipalActive(principal.principalId),true);
  assert.ok(!JSON.stringify(store.data).includes(BOT));
  assert.throws(()=>auth.principal({headers:{authorization:'Bearer unknown'}}),error=>error.status===401&&error.headers['WWW-Authenticate'].includes('resource_metadata'));
  assert.throws(()=>auth.admin({headers:{authorization:'Bearer '+BOT}}),error=>error.status===401);
});

test('DCR rejects unsafe redirects and authorization requires registered redirect, S256 and correct resource',async()=>{
  const {auth}=fixture();
  for(const redirect of ['http://public.example.test/callback','https://user:pass@example.test/cb','https://example.test/cb#fragment','javascript:alert(1)']){
    assert.equal((await call(auth,'POST','/oauth/register',{redirect_uris:[redirect]},{'content-type':'application/json'})).status,400);
  }
  const id=await register(auth);
  for(const extra of [{redirect_uri:'https://evil.example.test/cb'},{code_challenge_method:'plain'},{resource:'https://other.example.test/mcp'},{scope:'antdesk:admin'}]){
    const {response}=await approval(auth,id,extra);assert.equal(response.status,400);assert.equal(response.headers.location,undefined);
  }
});

test('consent page escapes names, requires same-browser CSRF and explicit administrator consent',async()=>{
  const {auth}=fixture(),id=await register(auth,'<script>alert(1)</script>');
  const approved=await approval(auth,id);
  assert.ok(!approved.response.body.includes('<script>'));
  assert.ok(approved.response.headers['content-security-policy'].includes("frame-ancestors 'none'"));
  assert.match(approved.response.headers['set-cookie'],/HttpOnly; Secure; SameSite=Lax/);
  const data={approval_id:approved.approvalId,csrf:approved.csrf,agent_id:'gptdot',admin_token:ADMIN,decision:'allow'};
  const noCookie=await formCall(auth,'/oauth/authorize',data,{origin:ISSUER});assert.equal(noCookie.status,400);
  const wrongOrigin=await formCall(auth,'/oauth/authorize',data,{cookie:approved.cookie,origin:'https://evil.example.test'});assert.equal(wrongOrigin.status,400);
  const wrongCsrf=await formCall(auth,'/oauth/authorize',{...data,csrf:'wrong'},{cookie:approved.cookie,origin:ISSUER});assert.equal(wrongCsrf.status,400);
  const wrongAdmin=await formCall(auth,'/oauth/authorize',{...data,admin_token:'bad'},{cookie:approved.cookie,origin:ISSUER});assert.equal(wrongAdmin.status,401);
  const denied=await formCall(auth,'/oauth/authorize',{approval_id:approved.approvalId,csrf:approved.csrf,decision:'deny'},{cookie:approved.cookie,origin:ISSUER});
  assert.equal(denied.status,302);assert.equal(new URL(denied.headers.location).searchParams.get('error'),'access_denied');
  assert.equal(new URL(denied.headers.location).searchParams.get('iss'),ISSUER);
  const reused=await formCall(auth,'/oauth/authorize',data,{cookie:approved.cookie,origin:ISSUER});assert.equal(reused.status,400);
});

test('authorization code enforces PKCE, client, redirect and resource before issuing scoped opaque tokens',async()=>{
  const {auth,store}=fixture(),id=await register(auth),g=await grant(auth,id);
  assert.equal((await exchange(auth,id,g,{code_verifier:'x'.repeat(64)})).status,400);
  assert.equal((await exchange(auth,id,g,{resource:'https://other.example.test/mcp'})).json().error,'invalid_target');
  assert.equal((await exchange(auth,id,g,{redirect_uri:'https://evil.example.test'})).status,400);
  const other=await register(auth,'other');assert.equal((await exchange(auth,other,g)).status,400);
  const response=await exchange(auth,id,g);assert.equal(response.status,200,response.body);
  const tokens=response.json(),principal=auth.authenticate(tokens.access_token);
  assert.equal(principal.agentId,'gptdot');assert.equal(tokens.token_type,'Bearer');assert.equal(tokens.expires_in,3600);
  assert.equal(auth.isPrincipalActive(principal.principalId),true);
  const serialized=JSON.stringify(store.data);
  for(const secret of [ADMIN,BOT,g.code,tokens.access_token,tokens.refresh_token])assert.ok(!serialized.includes(secret),'No raw credential in persisted OAuth state');
});

test('refresh rotates credentials, keeps agent and audience, detects replay and immediately revokes the grant',async()=>{
  const {auth}=fixture(),id=await register(auth),g=await grant(auth,id);
  const tokens=(await exchange(auth,id,g)).json(),principal=auth.authenticate(tokens.access_token);
  const args={grant_type:'refresh_token',client_id:id,refresh_token:tokens.refresh_token,resource:RESOURCE};
  const wrong=await formCall(auth,'/oauth/token',{...args,resource:'https://elsewhere.example.test/mcp'});assert.equal(wrong.status,400);
  const rotated=await formCall(auth,'/oauth/token',args);assert.equal(rotated.status,200,rotated.body);
  const next=rotated.json();assert.notEqual(next.refresh_token,tokens.refresh_token);
  assert.deepEqual(auth.authenticate(next.access_token),principal);
  const replay=await formCall(auth,'/oauth/token',args);assert.equal(replay.json().error,'invalid_grant');
  assert.equal(auth.authenticate(tokens.access_token),null);assert.equal(auth.authenticate(next.access_token),null);
  assert.equal(auth.isPrincipalActive(principal.principalId),false);
});

test('expiry and explicit revocation invalidate access; valid refresh can preserve an event subscription',async()=>{
  const {auth,store,advance}=fixture(),id=await register(auth),g=await grant(auth,id);
  const tokens=(await exchange(auth,id,g)).json(),principal=auth.authenticate(tokens.access_token);
  advance(60*60*1000+1);assert.equal(auth.authenticate(tokens.access_token),null);
  assert.equal(auth.isPrincipalActive(principal.principalId),true);
  store.commit(state=>{state.subscriptions.test={principalId:principal.principalId,active:true};});
  const revoke=await formCall(auth,'/oauth/revoke',{client_id:id,token:tokens.refresh_token});
  assert.equal(revoke.status,200);assert.equal(auth.isPrincipalActive(principal.principalId),false);
  assert.equal(store.data.subscriptions.test.active,false);
  assert.equal((await formCall(auth,'/oauth/revoke',{client_id:id,token:'unknown'})).status,200);
});

test('an authorization code replay revokes its prior grant; expired authorization flows cannot mint tokens',async()=>{
  const {auth,advance}=fixture(),id=await register(auth),g=await grant(auth,id);
  const tokens=(await exchange(auth,id,g)).json();
  assert.equal((await exchange(auth,id,g)).json().error,'invalid_grant');
  assert.equal(auth.authenticate(tokens.access_token),null);
  const second=await grant(auth,id);advance(2*60*1000+1);
  assert.equal((await exchange(auth,id,second)).json().error,'invalid_grant');
});

test('OAuth grants survive a bridge restart and expire after their bounded lifetime',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'antdesk-auth-test-')),file=join(dir,'state.json');
  let store=new Store(file,ADMIN);
  try{
    const first=fixture({store}),id=await register(first.auth),g=await grant(first.auth,id);
    const tokens=(await exchange(first.auth,id,g)).json(),principal=first.auth.authenticate(tokens.access_token);
    assert.ok(!readFileSync(file,'utf8').includes(tokens.access_token));
    store.close();store=new Store(file,ADMIN);
    const restored=fixture({store});assert.deepEqual(restored.auth.authenticate(tokens.access_token),principal);
    restored.advance(31*24*60*60*1000);
    assert.equal(restored.auth.authenticate(tokens.access_token),null);
    assert.equal(restored.auth.isPrincipalActive(principal.principalId),false);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
