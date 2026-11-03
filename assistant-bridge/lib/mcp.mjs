import { BridgeError, json } from './util.mjs';
import { EVENT_DEFINITION } from './events.mjs';

const input = (properties={},required=[]) => ({type:'object',properties,required,additionalProperties:false});
const run={run_id:{type:'string',description:'Execution ID from the task event or task list.'}};
const update={...run,text:{type:'string'},idempotency_key:{type:'string',description:'A stable unique key reused only when retrying this exact update.'}};
export const TOOLS = [
  {name:'list_tasks',description:'List tasks assigned to this connected assistant.',inputSchema:input(),annotations:{readOnlyHint:true}},
  {name:'get_task',description:'Read the task requirements and latest state before doing work.',inputSchema:input(run,['run_id']),annotations:{readOnlyHint:true}},
  {name:'claim_task',description:'Claim an assigned task before execution. A closed task cannot be claimed.',inputSchema:input(run,['run_id']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'report_progress',description:'Save a concise progress update on your task.',inputSchema:input(update,['run_id','text','idempotency_key']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'submit_result',description:'Submit the final result for the user to review. This does not mark their underlying to-do complete.',inputSchema:input(update,['run_id','text','idempotency_key']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'fail_task',description:'Report why you could not complete an assigned task.',inputSchema:input(update,['run_id','text','idempotency_key']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'list_priority_queue',description:'Read the live task queue, revision, project constraints and acceptance evidence. In PMO mode priority changes require the user to accept a proposal.',inputSchema:input(),annotations:{readOnlyHint:true}},
  {name:'reorder_priority_queue',description:'Propose a priority order in PMO mode; it is saved for the user to accept in AntDesk and does not change the live order. Pass the current revision, each task ID at most once, and a rationale. Outside PMO mode this retains the legacy direct-reorder behavior. Unmentioned tasks retain their relative order.',inputSchema:input({expected_revision:{type:'integer',minimum:0},ordered_task_ids:{type:'array',maxItems:1000,uniqueItems:true,items:{type:'string'}},rationale:{type:'string',maxLength:4000}},['expected_revision','ordered_task_ids']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
];
export async function handleMcp(req,res,request,principal,{jobs,events,queueRequest}) {
  if(!request||request.jsonrpc!=='2.0'||typeof request.method!=='string'||Array.isArray(request)) return json(res,400,{jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:'Invalid JSON-RPC request.'}});
  const {id,method,params={}}=request;
  if(id===undefined){if(method==='notifications/initialized') {res.writeHead(202);res.end();return;}return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'This operation requires a request ID.'}});}
  const reply=result=>json(res,200,{jsonrpc:'2.0',id,result});
  try {
    if(method==='initialize') return reply({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(params.protocolVersion)?params.protocolVersion:'2025-03-26',capabilities:{tools:{},events:{},experimental:{events:{}}},serverInfo:{name:'antdesk-native-bridge',version:'1.0.0'},instructions:'Read and claim tasks assigned to your identity. Report progress, then submit_result or fail_task with stable update keys. Task results await user review. Do not execute tasks after they are cancelled. To review the user\'s priorities, call list_priority_queue and inspect its PMO constraints, then reorder_priority_queue with that exact revision and rationale. With PMO enabled this only creates a pending proposal; the user must accept it in AntDesk before the queue changes. Never treat proposal creation as approval to execute or expand scope.'});
    if(method==='server/discover')return reply({resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{},events:{}},serverInfo:{name:'antdesk-native-bridge',version:'1.0.0'}});
    if(method==='ping')return reply({});
    if(method==='tools/list')return reply({tools:TOOLS});
    if(method==='events/list')return reply({events:[{...EVENT_DEFINITION,inputSchema:{...EVENT_DEFINITION.inputSchema,properties:{agent_id:{type:'string',const:principal.agentId,description:'Your connected assistant identity.'}}}}]});
    if(method==='events/subscribe')return reply(await events.subscribe(principal,params));
    if(method==='events/unsubscribe')return reply(events.unsubscribe(principal,params));
    if(method==='tools/call'){
      if(!TOOLS.some(tool=>tool.name===params.name))throw new BridgeError(404,'unknown_tool','Unknown tool.');
      try {
        if(params.name==='list_priority_queue'||params.name==='reorder_priority_queue'){
          if(!queueRequest)throw new BridgeError(409,'queue_unavailable','The desktop planner is not connected.');
          const result=await queueRequest(params.name,params.arguments||{});
          return reply({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
        }
        const result=jobs.tool(principal,params.name,params.arguments||{});return reply({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
      }
      catch(error){if(!(error instanceof BridgeError))throw error;return reply({content:[{type:'text',text:error.message}],structuredContent:{error:{code:error.code,message:error.message}},isError:true});}
    }
    return json(res,200,{jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found.'}});
  }catch(error){
    const known=error instanceof BridgeError;
    const code=known&&error.code==='callback_verification_failed'?-32015:known?-32602:-32603;
    return json(res,200,{jsonrpc:'2.0',id,error:{code,message:known?error.message:'The bridge could not complete this request.',data:known?{reason:error.code}:undefined}});
  }
}
