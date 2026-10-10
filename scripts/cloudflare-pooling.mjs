// Provision pool-only configurations using captured CLI credentials; no secrets on argv.
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {root,serviceNames,validateDeployment,validateServiceDatabaseUrls} from './cloudflare.mjs';
const config=validateDeployment(JSON.parse(await readFile(join(root,'.cloudflare/deployment.json'),'utf8')),true);
const secrets=JSON.parse(await readFile(join(root,'.cloudflare/secrets.json'),'utf8'));
validateServiceDatabaseUrls(config,secrets);
const auth=await new Promise((resolve,reject)=>{
 const child=spawn('pnpm',['exec','wrangler','auth','token','--json'],{cwd:root,env:{...process.env,XDG_CONFIG_HOME:join(root,'.cloudflare/cli-config'),CI:'true'},stdio:['ignore','pipe','ignore']});
 let out='';child.stdout.on('data',d=>out+=d);child.on('error',()=>reject(new Error('CLI authentication unavailable')));child.on('close',code=>{try{const j=JSON.parse(out);if(code||!j.token)throw new Error();resolve(j.token);}catch{reject(new Error('CLI authentication unavailable'));}});
});
async function api(method,path,body){
 const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/hyperdrive/configs${path}`,{method,headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 const j=await r.json();if(!r.ok||!j.success)throw new Error(`Hyperdrive operation unavailable: HTTP ${r.status}, codes ${(j.errors??[]).map(e=>e.code).join(',')}. Authorize Hyperdrive in CLI before retrying.`);return j.result;
}
try{
 const existing=await api('GET','');config.hyperdrive??={};
 for(const name of serviceNames){
  const url=new URL(secrets.databaseUrls[name]),label=`${config.prefix}-${name}-pool`;
  let resource=existing.find(x=>x.name===label);
  if(resource && (resource.caching?.disabled!==true || resource.origin?.database!==decodeURIComponent(url.pathname.slice(1)) || resource.origin?.user!==decodeURIComponent(url.username) || resource.origin?.host!==url.hostname))throw new Error(`Existing ${name} pool configuration differs; refusing to reuse it`);
  if(!resource)resource=await api('POST','',{name:label,origin:{scheme:'postgres',host:url.hostname,port:Number(url.port||5432),database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),sslmode:'verify-full'},caching:{disabled:true},origin_connection_limit:5});
  if(!/^[a-f\d]{32}$/.test(resource.id))throw new Error('Unexpected pool identity');
  config.hyperdrive[name]=resource.id;
  await writeFile(join(root,'.cloudflare/deployment.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
  console.log(`${name}: verified pool-only binding recorded`);
 }
}catch(error){console.error(error.message);process.exitCode=1;}
