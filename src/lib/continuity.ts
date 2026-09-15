import {invoke, isTauri} from '@tauri-apps/api/core';
export interface DayEntry {id:string;kind:'user'|'assistant'|'project';text:string;created:number;matched:boolean}
export interface DayContext {conversation:string;startedAt:number|null;observedAt:number;since:number;messageCount:number;observationCount:number;messages:DayEntry[];observations:DayEntry[];scope:string}
export interface Observation {source:string;fingerprint:string;text:string}
export async function activateConversation(conversation:string) {
  if(isTauri()) await invoke('pm_activate_conversation',{conversation});
}
export async function recordObservations(conversation:string,entries:Observation[]) {
  if(!isTauri())return;
  for(let i=0;i<entries.length;i+=64) await invoke('pm_record_observations',{conversation,entries:entries.slice(i,i+64)});
}
export async function dayContext(conversation:string,query=''):Promise<DayContext> {
  if(isTauri())return invoke('pm_day_context',{conversation,query:query.slice(0,500)});
  const now=Date.now()/1000;
  return {conversation,startedAt:null,observedAt:now,since:now-86400,messageCount:0,observationCount:0,messages:[],observations:[],scope:'浏览器预览未连接本机全天记录'};
}
