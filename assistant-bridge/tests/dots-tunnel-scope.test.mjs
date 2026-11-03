import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBridge} from '../server.mjs';

test('official tunnel token can only access its own MCP queue, never desktop management',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'antdesk-tunnel-scope-'));
  const adminToken='fixture-admin-token-at-least-32-characters';
  const create=()=>createBridge({storePath:path.join(dir,'state.json'),adminToken,
    webhookFetch:async(_url,request)=>new Response(JSON.stringify({challenge:JSON.parse(request.body).challenge}),{status:200})});
  let bridge=await create();
  try {
    const base=await bridge.listen();
    const saved=bridge.state.data.runtime.providers['dots-direct'].secrets.mcpToken;
    const token=bridge.state.unseal(saved);assert.notEqual(token,adminToken);assert.ok(!fs.readFileSync(path.join(dir,'state.json'),'utf8').includes(token));
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
    assert.equal((await fetch(base+'/api/runtime/providers',{headers})).status,401);
    await fetch(base+'/mcp',{method:'POST',headers:{...headers,'X-AntDesk-Discovery':'1'},body:JSON.stringify({jsonrpc:'2.0',id:'discovery',method:'tools/list'})});
    assert.equal(bridge.state.data.agents['omdot-events'],undefined,'Local discovery must not prove a cloud connection');
    const mcp=async(method,params={})=>(await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:'fixture',method,params})})).json();
    const tools=await mcp('tools/list');assert.ok(tools.result.tools.some(t=>t.name==='get_task'));
    assert.ok(bridge.state.data.agents['omdot-events'].lastSeenAt>0);
    const wrong=await mcp('events/subscribe',{name:'antdesk.task.assigned',arguments:{agent_id:'muse-personal'},delivery:{mode:'webhook',url:'https://callback.example.test/events',secret:'whsec_dGVzdC1ldmVudC1zaWduaW5nLXNlY3JldA=='}});
    assert.ok(wrong.error);
    const good=await mcp('events/subscribe',{name:'antdesk.task.assigned',arguments:{agent_id:'omdot-events'},delivery:{mode:'webhook',url:'https://callback.example.test/events',secret:'whsec_dGVzdC1ldmVudC1zaWduaW5nLXNlY3JldA=='}});
    assert.ok(good.result.id);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{...headers,Authorization:'Bearer '+adminToken},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).status,401);
    await bridge.close();bridge=await create();
    assert.equal(bridge.state.unseal(bridge.state.data.runtime.providers['dots-direct'].secrets.mcpToken),token);
  }finally{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});}
});
