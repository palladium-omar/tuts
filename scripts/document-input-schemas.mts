import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {clientDiagnosticsSchema} from '../services/platform/src/schemas.js';
import {summaryBatch} from '../services/reporting/src/schemas.js';
import {reviewSchema} from '../services/billing/src/history-identity.js';
const root=resolve(import.meta.dirname,'..');
const {z}=createRequire(resolve(root,'services/reporting/package.json'))('zod');
export const reviewedInputs=[
 {method:'POST',path:'/api/platform/v1/client-diagnostics',symbol:'clientDiagnosticsSchema',source:'services/platform/src/schemas.ts',schema:clientDiagnosticsSchema,serverRules:['Verified session and approved mutation origin required. JSON body is limited to 2048 bytes. Only categorical allowlisted event fields are accepted.'],example:{events:[{kind:'TypeError',source:'window',view:'learning'}]}},
 {method:'POST',path:'/api/reporting/v1/summaries',symbol:'summaryBatch',source:'services/reporting/src/schemas.ts',schema:summaryBatch,serverRules:['Month year must be between 2000 and 2200. timeZone must be a valid IANA zone. These refinements are not represented by JSON Schema.','Current business membership, Reporting entitlement, staff role, reporting.read and access to every requested/canonical student are required. includeFinancial additionally requires billing.read, reporting.financial and the Billing entitlement.'],example:{studentIds:['11111111-1111-4111-8111-111111111111'],month:'2026-10',timeZone:'Africa/Casablanca',includeFinancial:false}},
 {method:'PATCH',path:'/api/billing/v1/work-log/:id/identity',symbol:'reviewSchema',source:'services/billing/src/history-identity.ts',schema:reviewSchema,serverRules:['linked requires a nonnull studentId; unknown and ambiguous forbid a nonnull studentId. This cross-field refinement is not represented by JSON Schema.','Current membership, business-wide access, owner/admin/tutor role, billing.read, reporting.financial, billing.write and Billing entitlement are required. Linked reviews additionally require Clients entitlement, clients.read and owner-service verification of an accessible canonical CRM student.','Both expected revisions must match current records; conflict returns 409. Preserved imported source names are unchanged.'],example:{status:'linked',studentId:'11111111-1111-4111-8111-111111111111',expectedWorkRevision:1,expectedIdentityRevision:0,reason:'Reviewed synthetic identity'}},
];
export async function inputCatalog() {
 return {scope:'Three reviewed request validators only. This is not complete OpenAPI request or response coverage. JSON Schema describes input shape; custom refinements, transformations, authentication, permissions and revision checks remain authoritative server behavior.',generator:'pnpm exec tsx --tsconfig tsconfig.base.json scripts/document-input-schemas.mts',inputs:await Promise.all(reviewedInputs.map(async ({schema,...entry})=>{
  schema.parse(entry.example);
  const source=await readFile(resolve(root,entry.source),'utf8');
  const definition=source.indexOf(`export const ${entry.symbol}`);
  if(definition<0)throw new Error(`Missing exported validator: ${entry.symbol}`);
  return {...entry,sourceLine:source.slice(0,definition).split('\n').length,sourceSha256:createHash('sha256').update(source).digest('hex'),jsonSchema:z.toJSONSchema(schema,{io:'input',target:'draft-2020-12'})};
 }))};
}
if(process.argv[1] && resolve(process.argv[1])===resolve(import.meta.filename)) {
 const output=JSON.stringify(await inputCatalog(),null,2)+'\n',path=resolve(root,'docs/api-input-schemas.json');
 if(process.argv.includes('--check')) {if(await readFile(path,'utf8')!==output)throw new Error('Reviewed input schema catalog is stale; regenerate it.');}
 else await writeFile(path,output);
 console.log('Documented three reviewed request validators; examples parse against actual Zod schemas.');
}
