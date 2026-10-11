/** PostgreSQL JSONB reorders object properties. Compare deadline meaning rather
 * than serialization order; provenance URL order and equivalent timestamp
 * offsets do not change the proposed deadline. */
export function sameDeadline(current:unknown,proposed:unknown):boolean {
 const canonical=(value:unknown,key=''):unknown=>{
  if(Array.isArray(value)){
   const items=value.map(item=>canonical(item));
   return key==='sourceUrls'?[...items].sort((a,b)=>String(a).localeCompare(String(b))):items;
  }
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v,k)]));
  if(typeof value==='string'&&['dueAt','verifiedAt'].includes(key)){
   const time=Date.parse(value);if(Number.isFinite(time))return new Date(time).toISOString();
  }
  return value;
 };
 return JSON.stringify(canonical(current??null))===JSON.stringify(canonical(proposed??null));
}
