// Test-only Worker: no database, storage, credentials, or production bindings.
import { parseImportFile } from '../../services/clients/dist/parse-import.js';
import { parseHistoryFile, historyOptionsSchema } from '../../services/billing/dist/history-parser.js';

export default {
 async fetch(request){
  if(request.method!=='POST')return new Response('Workbook parser regression worker');
  try{
   const bytes=Buffer.from(await request.arrayBuffer());
   if(new URL(request.url).pathname==='/clients'){
    const parsed=await parseImportFile('synthetic.xlsx',bytes);
    return Response.json({rows:parsed.totalRows,columns:parsed.headers.length});
   }
   const {preview}=await parseHistoryFile('synthetic.xlsx',bytes,historyOptionsSchema.parse({kind:'work'}));
   return Response.json({summary:preview.summary,sheets:preview.sheets.length,reviewRows:preview.rows.filter(row=>row.errors.length).map(row=>row.rowNumber)});
  }catch(error){return Response.json({error:error.message},{status:400});}
 }
};
