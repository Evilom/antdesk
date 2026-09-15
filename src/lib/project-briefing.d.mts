import type {Engineering,WorkPackage} from './cockpit';
export function projectEventState(snapshot:Engineering|null,packages:WorkPackage[]):Record<string,string>;
export function changedProjectEvents(previous:Record<string,string>|null,next:Record<string,string>):string[];
export function dailyBriefingKey(now:Date,time:string):string;
export function buildProjectBriefing(snapshot:Engineering|null,packages:WorkPackage[],reason?:string):string;
