import {invoke, isTauri} from '@tauri-apps/api/core';
export interface WorkNode {id:string;title:string;status:'todo'|'doing'|'blocked'|'done';nextStep:string;dueDate:string;blocker:string;dependsOn:string[]}
export interface WorkLink {id:string;title:string;kind:string;path:string;line:number;nodeId:string;reason:string;baseline?:unknown}
export interface LinkedSource {id:string;title:string;path:string;kind?:string;reason?:string;error?:string;changed?:boolean;baseline?:{excerpt:string;observedAt:number};current?:{excerpt:string;hash:string;line:number;source:string;observedAt:number}}
export interface WorkPackage {links?:WorkLink[];id:string;project:string;title:string;goal:string;revision:number;nodes:WorkNode[];updatedAt?:number}
export interface CheckRun {databaseId?:number;id?:string;label?:string;workflowName?:string;head?:string;headSha?:string;status:string;conclusion?:string;clean?:boolean;updatedAt?:string;startedAt?:number;completedAt?:number;url?:string;source?:string}
export interface ProjectFact {path:string;observedAt:number;error?:string;kind?:string;notice?:string;git?:{branch:string;head:string;dirty:boolean;consistent:boolean;staged:number;modified:number;untracked:number;conflicts:number;files:Array<{path:string;status:string}>};ci?:{release?:{tagName:string;url:string;assets:Array<{name:string;size:number}>};observedAt?:number;runs?:CheckRun[];error?:string;notice?:string};localChecks?:{runs?:CheckRun[];error?:string;notice?:string}}
export interface Engineering {observedAt:number;projects:ProjectFact[];truncated?:boolean}
export interface Revision {revision:number;created:number;source:string;package:WorkPackage}
let pending:Promise<Engineering>|null=null;
export function engineering():Promise<Engineering> {
  if(!isTauri())return Promise.resolve({observedAt:Date.now()/1000,projects:[]});
  if(pending)return pending;
  pending=invoke<Engineering>('pm_engineering').finally(()=>{pending=null;});return pending;
}
export function workPackages():Promise<WorkPackage[]> {return isTauri()?invoke('pm_work_packages'):Promise.resolve([]);}
export function savePackage(packageValue:WorkPackage):Promise<number> {return invoke('pm_save_work_package',{package:packageValue});}
export function workTimeline(id:string):Promise<Revision[]> {return invoke('pm_work_timeline',{id});}
export function newNode():WorkNode{return {id:crypto.randomUUID(),title:'',status:'todo',nextStep:'',dueDate:'',blocker:'',dependsOn:[]};}

export function linkedSources(id:string):Promise<LinkedSource[]> {return isTauri()?invoke('pm_linked_sources',{id}):Promise.resolve([]);}
