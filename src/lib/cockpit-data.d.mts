import type { Engineering, ProjectFact, CheckRun, WorkPackage, WorkNode } from './cockpit';
export const NODE_LABELS: Record<string,string>;
export function readyNodes(pack:WorkPackage):WorkNode[];
export function evidenceLabel(run:CheckRun, project:ProjectFact):string;
export function resultLabel(run:CheckRun):string;
export function cockpitContext(snapshot:Engineering|null, packages:WorkPackage[], query?:string):string;
