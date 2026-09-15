import {create} from 'zustand';
import {engineering, workPackages, type Engineering, type WorkPackage} from './cockpit';

interface Feed {
  snapshot: Engineering | null;
  packages: WorkPackage[];
  engineeringError: string;
  packagesError: string;
  packagesAt: number;
  checking: boolean;
}
export const useProjectFeed = create<Feed>(() => ({snapshot:null,packages:[],engineeringError:'',packagesError:'',packagesAt:0,checking:false}));
let pending: Promise<Feed> | null = null;
/** Each source keeps its last successful snapshot and its own failure state. */
export function refreshProjectFeed(): Promise<Feed> {
  if (pending) return pending;
  useProjectFeed.setState({checking:true});
  pending = Promise.allSettled([engineering(),workPackages()]).then(([facts,packs]) => {
    useProjectFeed.setState({
      ...(facts.status==='fulfilled' ? {snapshot:facts.value,engineeringError:''} : {engineeringError:String(facts.reason)}),
      ...(packs.status==='fulfilled' ? {packages:packs.value,packagesAt:Date.now()/1000,packagesError:''} : {packagesError:String(packs.reason)}),
      checking:false,
    });
    return useProjectFeed.getState();
  }).finally(()=>{pending=null;});
  return pending;
}
