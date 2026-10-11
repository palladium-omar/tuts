import {onApiInvalidation, type Api, type Row} from '../../lib/api';
import {fetchOverview, type OverviewDomain} from './overview-model';
export type OverviewLoad = {loading:boolean;error?:string;data?:Row};
type Invalidation = (matches:(path:string)=>boolean,reason?:'access'|'dispose')=>void;
type Subscribe = (api:Api,listener:Invalidation)=>()=>void;
// The API has one persistent invalidation callback; mounted observers detach.
const listeners = new WeakMap<Api, Set<Invalidation>>();
const subscribe:Subscribe = (api,listener)=>{
  let group=listeners.get(api);
  if(!group) {
    group=new Set();listeners.set(api,group);
    const current=group;
    onApiInvalidation(api,(matches,reason)=>{for(const notify of current)notify(matches,reason);});
  }
  group.add(listener);
  return ()=>{group.delete(listener);};
};
export function createOverviewLoader(api:Api,domains:OverviewDomain[],studentId:string,
  update:(domain:OverviewDomain,state:OverviewLoad)=>void,
  message:(error:unknown)=>string,subscribeInvalidation:Subscribe=subscribe) {
  let active=true;
  const generations:Partial<Record<OverviewDomain,number>>={};
  const saved:Partial<Record<OverviewDomain,Row>>={};
  const path=(domain:OverviewDomain)=>`${domain}/v1/${domain==='planning'?'':'portal/'}overview?studentId=${encodeURIComponent(studentId)}`;
  async function refresh(domain:OverviewDomain) {
    if(!active || !domains.includes(domain))return;
    const generation=(generations[domain]??0)+1;generations[domain]=generation;
    update(domain,{loading:true,data:saved[domain]});
    try {
      const data=await fetchOverview(api,domain,studentId);
      if(active&&generations[domain]===generation){saved[domain]=data;update(domain,{loading:false,data});}
    }catch(error){
      if(active&&generations[domain]===generation)update(domain,{loading:false,data:saved[domain],error:message(error)});
    }
  }
  const detach=subscribeInvalidation(api,(matches,reason)=>{
    if(!active)return;
    if(reason){
      // Access/disposal invalidations never fetch under a revoked context.
      for(const domain of domains)update(domain,{loading:false,error:'Access changed. Refresh your learning space.'});
      active=false;detach();return;
    }
    for(const domain of domains)if(matches(path(domain)))void refresh(domain);
  });
  for(const domain of domains)void refresh(domain);
  return {refresh,dispose(){active=false;detach();}};
}
