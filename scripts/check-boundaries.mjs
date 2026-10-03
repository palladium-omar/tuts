import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const services=['platform','clients','scheduling','learning','billing','payments','notifications'];
async function walk(dir){const entries=await readdir(dir,{withFileTypes:true}).catch(()=>[]);return(await Promise.all(entries.filter(e=>!['node_modules','dist','.next'].includes(e.name)).map(e=>e.isDirectory()?walk(resolve(dir,e.name)):resolve(dir,e.name)))).flat();}
const failures=[];
for(const service of services){
 const serviceRoot=resolve(root,'services',service);
 const manifest=JSON.parse(await readFile(resolve(serviceRoot,'package.json'),'utf8'));
 for(const name of Object.keys(manifest.dependencies??{}))if(services.some(s=>name===`@palladium/${s}`))failures.push(`${service}: cross-service package ${name}`);
 for(const file of await walk(serviceRoot)){
  if(!/\.(ts|tsx|js|mjs)$/.test(file))continue;
  const text=await readFile(file,'utf8');
  for(const match of text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)){
   const target=match[1];
   if(target.startsWith('.') && relative(serviceRoot,resolve(file,'..',target)).startsWith('..'))failures.push(`${relative(root,file)}: escapes service through ${target}`);
   if(/^@palladium\//.test(target) && !['@palladium/contracts','@palladium/service-kit'].includes(target))failures.push(`${relative(root,file)}: cross-service import ${target}`);
  }
 }
}
if(failures.length){console.error(failures.join('\n'));process.exit(1);}console.log('Service import boundaries verified across seven independent packages.');
