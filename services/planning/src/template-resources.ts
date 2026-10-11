// Canonicalize URL scheme/host as URL does; preserve path case and query values.
function referenceIdentity(reference:Record<string,unknown>):string {
 if(reference.kind==='learning_resource')return `learning_resource:${reference.resourceId}`;
 try{return `url:${new URL(String(reference.url)).href}`;}catch{return JSON.stringify(reference);}
}
export function mergeTemplateResources(currentReferences:Record<string,unknown>[],currentChecklist:{id:string;text:string;done:boolean}[],proposedReferences:Record<string,unknown>[],proposedChecklist:{id:string;text:string;done:boolean}[]) {
 const references=[...currentReferences],checklist=[...currentChecklist];
 const seenReferences=new Set(references.map(referenceIdentity)),ids=new Set(checklist.map(item=>item.id)),texts=new Set(checklist.map(item=>item.text.trim()));
 for(const reference of proposedReferences){const identity=referenceIdentity(reference);if(!seenReferences.has(identity)){references.push(reference);seenReferences.add(identity);}}
 for(const item of proposedChecklist){if(!ids.has(item.id)&&!texts.has(item.text.trim())){checklist.push({...item,done:false});ids.add(item.id);texts.add(item.text.trim());}}
 return {references,checklist,changed:references.length!==currentReferences.length||checklist.length!==currentChecklist.length};
}
