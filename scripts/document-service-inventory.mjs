import {readdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import ts from 'typescript';
const root=resolve(import.meta.dirname,'..');
const names=['platform','clients','scheduling','learning','billing','payments','notifications','integrations','planning','reporting'];
async function walk(path){return(await Promise.all((await readdir(path,{withFileTypes:true})).map(e=>e.isDirectory()?walk(resolve(path,e.name)):resolve(path,e.name)))).flat();}
function decorators(node){return ts.canHaveDecorators(node)?ts.getDecorators(node)??[]:[];}
function call(decorator){const e=decorator.expression;return ts.isCallExpression(e)?{name:e.expression.getText(),args:e.arguments.map(a=>ts.isStringLiteral(a)?a.text:a.getText())}:null;}
function meta(node){return decorators(node).map(call).filter(Boolean);}
const lines=['# Service API and database inventory','','Generated from controller declarations and SQL migrations by `node scripts/document-service-inventory.mjs`. This is a route and ownership inventory, not a complete OpenAPI schema or proof of runtime access. Zod schemas in each service define request validation. Read [HTTP](architecture/http.md), [security](architecture/security.md), and the service README before integration.','','Gateway adds `/api/{service}` to each domain path. `@Public` means the shared session-context guard is bypassed; provider/internal routes still require their own secrets or signatures. Omitted roles default to staff under the shared guard; student routes also need explicit resource checks. Class and method metadata are shown together, so consult controller code for overrides. `/health` is shared. The shared `/openapi.json` route is registered before router initialization; concrete input-schema coverage and limits are documented separately.','','Only the owning service may read or write the tables below. Runtime-owned `service_migrations`, `service_outbox`, `service_inbox`, and `service_request_budgets` exist in each database and are omitted from the domain lists.'];
let routes=0;
for(const name of names){
 lines.push('',`## ${name}`,'',`Local port: ${4001+names.indexOf(name)}. [Service guide](../services/${name}/README.md).`, '', '| Method | Service path | Declared access metadata | Controller |','| --- | --- | --- | --- |');
 for(const file of (await walk(resolve(root,'services',name,'src'))).filter(f=>f.endsWith('.ts')).sort()){
  const source=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true);
  function visit(node){
   if(ts.isClassDeclaration(node)){
    const classMeta=meta(node),base=classMeta.find(d=>d.name==='Controller');
    if(base){for(const method of node.members){if(!ts.isMethodDeclaration(method))continue;const methodMeta=meta(method),verb=methodMeta.find(d=>['Get','Post','Patch','Put','Delete','Head','Options','All'].includes(d.name));if(!verb)continue;
     const path='/'+[base.args[0]??'',verb.args[0]??''].filter(Boolean).join('/');
     const access=[...classMeta,...methodMeta].filter(d=>['Public','Roles','Permissions','StudentScoped'].includes(d.name)).map(d=>d.name+(d.args.length?'('+d.args.join(', ')+')':'')).join('; ')||'Shared staff/context guard';
     const line=source.getLineAndCharacterOfPosition(method.getStart(source)).line+1;const link=relative(root,file);
     lines.push(`| ${verb.name.toUpperCase()} | \`${path}\` | ${access.replaceAll('|','\\|')} | [${node.name?.text}.${method.name.getText()}](../${link}#L${line}) |`);routes++;
    }}
   }ts.forEachChild(node,visit);
  }visit(source);
 }
 lines.push('','### Owned schema','', '| Migration | Tables introduced |','| --- | --- |');
 for(const file of (await readdir(resolve(root,'services',name,'migrations'))).filter(f=>f.endsWith('.sql')).sort()){
  const sql=await readFile(resolve(root,'services',name,'migrations',file),'utf8');const tables=[...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w]+"?)/gi)].map(m=>'`'+m[1]+'`');
  lines.push(`| [${file}](../services/${name}/migrations/${file}) | ${tables.join(', ')||'Alters existing schema/policies'} |`);
 }
}
lines.push('','## Inventory maintenance','','Update controllers, validation schemas, service README and architecture contract in the same change. Regenerate this file and run `node scripts/document-service-inventory.mjs --check`. Internal Better Auth wildcard endpoints, shared health/runtime adapters and dynamically registered endpoints are described in the architecture documents rather than inferred by this generator.','');
const output=lines.join('\n'),path=resolve(root,'docs/service-inventory.md');
if(process.argv.includes('--check')){if(await readFile(path,'utf8')!==output){console.error('Service inventory is stale; regenerate it.');process.exit(1);}}else await writeFile(path,output);
console.log(`Documented ${routes} controller routes across ${names.length} services.`);
