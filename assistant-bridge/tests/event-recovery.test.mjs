import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

test('exhausted transient event responses stay unknown and a real bot result can still resolve them',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'antdesk-event-recovery-'));
  const adminToken='test-admin-'+ 'a'.repeat(32), botToken='test-dots-'+ 'b'.repeat(32), attempts=[];
  const bridge=await createBridge({storePath:path.join(directory,'state.json'),adminToken,publicUrl:'https://bridge.example.test',botTokens:[{agentId:'gptdot',token:botToken}],retryDelaysMs:[5,5],
    webhookFetch:async(_url,options)=>{
      const body=JSON.parse(options.body);
      if(body.type==='verification')return Response.json({challenge:body.challenge});
      attempts.push(body.eventId);return new Response(null,{status:503});
    }});
  try{
    await bridge.listen();
    const api=async(route,method='GET',body)=>{
      const response=await fetch(bridge.baseUrl+route,{method,headers:{Authorization:'Bearer '+adminToken,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      return {response,data:await response.json()};
    };
    const rpc=async(method,params)=>{
      const response=await fetch(bridge.baseUrl+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+botToken,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      return response.json();
    };
    await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}});
    const sub=await rpc('events/subscribe',{name:'antdesk.task.assigned',arguments:{agent_id:'gptdot'},delivery:{mode:'webhook',url:'https://callback.example.test/events',secret:'whsec_'+Buffer.alloc(32,3).toString('base64')}});
    assert.ok(sub.result.id);
    const created=await api('/api/runs','POST',{id:'run-transient',idempotencyKey:'idem-transient',taskId:'task-transient',title:'Test',instruction:'Research',agentId:'gptdot',protocol:'dots-mcp'});
    assert.equal(created.response.status,202);
    const deadline=Date.now()+3000;let current;
    do {current=(await api('/api/runs/run-transient')).data;if(current.status==='interrupted')break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
    assert.equal(current.status,'interrupted');assert.equal(current.deliveryStatus,'unknown');
    assert.equal(attempts.length,3);assert.equal(new Set(attempts).size,1);
    const duplicate=await api('/api/runs','POST',{id:'run-other',idempotencyKey:'idem-other',taskId:'task-transient',title:'Test',instruction:'Research',agentId:'gptdot',protocol:'dots-mcp'});
    assert.equal(duplicate.response.status,409);
    const result=await rpc('tools/call',{name:'submit_result',arguments:{run_id:'run-transient',text:'The actual bot finished the work.',idempotency_key:'result-1'}});
    assert.equal(result.result.isError,false);
    const resolved=(await api('/api/runs/run-transient')).data;
    assert.equal(resolved.status,'review');assert.equal(resolved.deliveryStatus,'accepted');assert.equal(resolved.result,'The actual bot finished the work.');
    await new Promise(resolve=>setTimeout(resolve,120));assert.equal(attempts.length,3);
  }finally{await bridge.close();await fs.rm(directory,{recursive:true,force:true});}
});
