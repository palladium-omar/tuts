import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { unstable_dev } from 'wrangler';
import { createConfigs, root } from './cloudflare.mjs';

// Build the shared kit, Clients and Billing first. Local workerd only: reuse
// production parser aliases/date/flags, never production resource bindings.
const aliases=createConfigs({publicUrl:'https://synthetic.workers.dev'},[],root).clients;
const ExcelJS=createRequire(resolve(root,'services/clients/package.json'))('exceljs');
const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('HoursLog');
sheet.addRow(['Date','Student Name','Service Type','Hours Worked','Hourly Rate (€)','Total (€)','Invoice Status','Notes']);
for(let i=0;i<100;i++)sheet.addRow([new Date('2026-09-03T00:00:00Z'),`Synthetic learner ${i}`,'Lesson',1.5,40,{formula:`D${i+2}*E${i+2}`,result:60},'Paid','Synthetic notes '.repeat(120)]);
const bytes=Buffer.from(await book.xlsx.writeBuffer({zip:{compression:'DEFLATE'}}));
const otherBook=new ExcelJS.Workbook(),otherSheet=otherBook.addWorksheet('HoursLog');
otherSheet.addRow(sheet.getRow(1).values.slice(1));
for(let i=0;i<7;i++)otherSheet.addRow([new Date('2026-09-04T00:00:00Z'),`Other synthetic learner ${i}`,'Coaching',2,50,100,'Sent','']);
const otherBytes=Buffer.from(await otherBook.xlsx.writeBuffer({zip:{compression:'DEFLATE'}}));
function forgedEntrySize(size){
 const forged=Buffer.from(bytes),end=forged.length-22;
 let offset=forged.readUInt32LE(end+16);
 for(let i=0;i<forged.readUInt16LE(end+10);i++){
  const nameLength=forged.readUInt16LE(offset+28),name=forged.subarray(offset+46,offset+46+nameLength).toString();
  if(name==='xl/worksheets/sheet1.xml'){forged.writeUInt32LE(size,offset+24);return forged;}
  offset+=46+nameLength+forged.readUInt16LE(offset+30)+forged.readUInt16LE(offset+32);
 }
 throw new Error('Fixture worksheet entry missing');
}
await mkdir(resolve(root,'.local'),{recursive:true});
const directory=await mkdtemp(resolve(root,'.local/workbook-regression-'));
const config=resolve(directory,'wrangler.json');
await writeFile(config,JSON.stringify({name:'workbook-parser-regression',main:resolve(root,'scripts/fixtures/workbook-runtime-worker.mjs'),compatibility_date:aliases.compatibility_date,compatibility_flags:aliases.compatibility_flags,alias:aliases.alias,send_metrics:false}));
let worker;
try{
 worker=await unstable_dev(resolve(root,'scripts/fixtures/workbook-runtime-worker.mjs'),{config,local:true,port:0,inspectorPort:0,persist:false,logLevel:'error',experimental:{forceLocal:true,watch:false,disableExperimentalWarning:true,disableDevRegistry:true}});
 async function preview(path,body=bytes,status=200){
  const response=await worker.fetch(`http://example.test/${path}`,{method:'POST',body,signal:AbortSignal.timeout(30000)});
  const text=await response.text();assert.equal(response.status,status,text);
  return JSON.parse(text);
 }
 for(let i=0;i<4;i++){
  assert.equal((await preview('clients')).rows,100);
  assert.deepEqual((await preview('billing')).summary,{valid:100,invalid:0,skipped:0});
 }
 await Promise.all(Array.from({length:8},async(_,i)=>{
  const other=i%3===0,result=await preview(i%2?'clients':'billing',other?otherBytes:bytes);
  assert.equal(i%2?result.rows:result.summary.valid,other?7:100);
 }));
 for(const path of ['clients','billing']){
  assert.match((await preview(path,forgedEntrySize(1),400)).error,/exceeds its declared size/);
  assert.match((await preview(path,forgedEntrySize(21*1024*1024),400)).error,/expanded size limit/);
  assert.match((await preview(path,Buffer.from('not a zip'),400)).error,/unencrypted workbook/);
  assert.ok(await preview(path)); // A rejection must not poison the next upload.
 }
 if(process.argv[2]){
  const original=await readFile(resolve(process.argv[2]));
  await preview('clients',original);
  const result=await preview('billing',original);
  console.log(JSON.stringify({providedWorkbook:result})); // Counts/row numbers only; no client contents.
 }
 console.log('Workbook Workers regression passed: repeated/concurrent XLSX, forged size, archive limit, malformed ZIP and recovery.');
}finally{
 await worker?.stop();
 await rm(directory,{recursive:true,force:true});
}
