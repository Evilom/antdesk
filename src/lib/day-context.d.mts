import type {DayContext,Observation} from './continuity';
import type {Engineering,WorkPackage} from './cockpit';
export function formatDayContext(day:DayContext,budget?:number):string;
export function projectObservations(feed:{snapshot:Engineering|null;packages:WorkPackage[];engineeringError:string;packagesError:string}):Promise<Observation[]>;
