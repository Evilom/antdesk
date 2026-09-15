import type {Engineering,ProjectFact} from './cockpit';
export interface SourceState {state:string;label:string;detail:string}
export function projectSources(snapshot:Engineering|null,error?:string,now?:number):SourceState;
export function checkSources(project:ProjectFact):Array<{name:string;state:string;detail:string}>;
