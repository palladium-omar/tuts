import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { validateWorkbookArchive } from './history-archive.js';

export const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
export const historyStatus = z.enum(['unsent', 'pending', 'paid']);
export const canonicalFields = ['date','studentName','serviceType','hours','rateMinor','amountMinor','currency','status','invoiceNumber','paidDate','notes'] as const;
const mappingSchema = z.object(Object.fromEntries(canonicalFields.map(key => [key,z.string().max(160).optional()]))).strict();
export const historyOptionsSchema = z.object({
  kind: z.enum(['work','invoices','archive','auto']).default('auto'),
  sheetName: z.string().max(160).optional(),
  mapping: mappingSchema.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  statusMap: z.record(z.string().max(100),z.union([historyStatus,z.literal('')])).optional(),
  countAsClasses: z.boolean().default(false),
}).strict();
export type HistoryOptions = z.infer<typeof historyOptionsSchema>;
export type HistoryStatus = z.infer<typeof historyStatus>;
export interface HistoryValues {
  date?: string; studentName?: string; serviceType?: string; hours?: number; rateMinor?: number;
  amountMinor?: number; currency?: string; status?: HistoryStatus; invoiceNumber?: string; paidDate?: string; notes?: string;
}
export interface PreviewRow { rowNumber: number; values: HistoryValues; errors: string[]; warnings: string[]; }
export interface RawRow { rowNumber: number; columns: Record<string,unknown>; cells: unknown[]; }
export interface RawSheet { name: string; headers: string[]; headerRow: number; rowCount: number; rows: RawRow[]; }
export interface HistoryPreview {
  kind: 'work'|'invoices'|'archive'; fileName: string; sheetName: string|null;
  sheets: {name:string;headers:string[];rowCount:number}[]; headers: string[];
  mapping: Record<string,string>; statusMap: Record<string,HistoryStatus|''>; rows: PreviewRow[];
  summary: {valid:number;invalid:number;skipped:number}; warnings:string[];
}
const fail = (message:string):never => { throw new BadRequestException(message); };
const text = (value:unknown):string => {
  if (value == null) return '';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0,10) : '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const cell = value as Record<string,any>;
    if ('formula' in cell || 'sharedFormula' in cell) return text(cell.result);
    if (Array.isArray(cell.richText)) return cell.richText.map((entry:any) => entry.text).join('');
    if ('text' in cell) return text(cell.text);
  }
  return '';
};
const aliases: Record<string,string[]> = {
  date: ['date','work date','invoice date','service date'], studentName: ['student name','student','payer name','client name','name'],
  serviceType: ['service type','service','description'], hours:['hours worked','hours','duration'],
  rateMinor:['hourly rate (€)','hourly rate','rate','hourly rate (eur)','rate minor'],
  amountMinor:['total (€)','total','amount','invoice amount','amount minor','total (eur)'],
  currency:['currency'],status:['invoice status','status','payment status'],invoiceNumber:['invoice number','invoice no','invoice #'],
  paidDate:['paid date','payment date'],notes:['notes','note'],
};
function inferredMapping(headers:string[]) {
  const mapping:Record<string,string> = {};
  for (const key of canonicalFields) {
    const header = headers.find(h => aliases[key]!.includes(h.toLowerCase().trim()));
    if (header) mapping[key] = header;
  }
  return mapping;
}
function rawSheet(name:string, matrix:{rowNumber:number;values:unknown[]}[]):RawSheet {
  if (matrix.length > 2001) fail('At most 2,000 data rows per sheet are supported');
  const first = matrix.find(row => row.values.some(value => text(value).trim()));
  const width = Math.max(0,...matrix.map(row => row.values.length));
  if (width > 100) fail('At most 100 columns per sheet are supported');
  const headers = Array.from({length:width}, (_,i) => text(first?.values[i]).trim() || `Column ${i+1}`);
  if (headers.some(h => h.length > 160)) fail('Headers may contain at most 160 characters');
  // Retain duplicate labels using distinct display labels; original header cells stay in raw rows.
  const seen = new Map<string,number>();
  const uniqueHeaders = headers.map(h => { const n=(seen.get(h)??0)+1;seen.set(h,n);return n===1?h:`${h} [${n}]`; });
  const rows = matrix.map(row => {
    if (row.values.some(value => JSON.stringify(value)?.length > 8000)) fail('A source cell exceeds the 8,000 character limit');
    return { rowNumber:row.rowNumber, columns:Object.fromEntries(uniqueHeaders.map((header,i)=>[header,row.values[i]??null])), cells:row.values };
  });
  return {name,headers:uniqueHeaders,headerRow:first?.rowNumber??0,rowCount:rows.filter(row=>row.rowNumber>(first?.rowNumber??0)&&row.cells.some(value=>text(value).trim())).length,rows};
}
function csvSheet(buffer:Buffer):RawSheet {
  if (buffer.includes(0)) fail('CSV must be UTF-8 text');
  let source:string;
  try { source=new TextDecoder('utf-8',{fatal:true}).decode(buffer); } catch { return fail('CSV must be valid UTF-8 text'); }
  let quoted=false;
  const counts=new Map([[',',0],[';',0],['\t',0]]);
  for(let i=0;i<source.length;i++) { const c=source[i]!; if(c==='"') { if(quoted&&source[i+1]==='"')i++;else quoted=!quoted; } else if(!quoted&&/[\r\n]/.test(c))break;else if(!quoted&&counts.has(c))counts.set(c,counts.get(c)!+1); }
  const delimiter=[...counts].sort((a,b)=>b[1]-a[1])[0]![0];
  try {
    const matrix = parse(source,{bom:true,delimiter,relax_column_count:true,skip_empty_lines:false,max_record_size:400100,on_record:(record:string[],info:{records:number})=>{
      if(info.records>2001||record.length>100)fail('CSV exceeds 2,000 rows or 100 columns');
      return record;
    }}) as string[][];
    return rawSheet('CSV',matrix.map((values,i)=>({rowNumber:i+1,values})));
  } catch(error) { if(error instanceof BadRequestException)throw error;return fail('CSV could not be parsed; check quotes and delimiters'); }
}
export function parseHistoryDate(value:unknown):string|undefined {
  const s=text(value).trim();
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(s) ?? (/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.test(s)?[s,...s.split('/').reverse()]:null);
  if (!match) return undefined;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  if(year<1900||year>2200)return undefined;
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day?`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`:undefined;
}
function decimal(value:unknown):{n:bigint;scale:bigint}|undefined {
  let s=text(value).trim().replace(/[€£$\s]/g,'');
  if(/^\d{1,3}(,\d{3})+\.\d+$/.test(s))s=s.replace(/,/g,'');
  else if(/^\d{1,3}(\.\d{3})+,\d+$/.test(s))s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(',')&&!s.includes('.'))s=s.replace(',','.');
  if(!/^\d+(?:\.\d{1,12})?$/.test(s))return undefined;
  const [whole,fraction='']=s.split('.');
  return {n:BigInt(whole!+fraction),scale:10n**BigInt(fraction.length)};
}
const round=(n:bigint,scale:bigint)=> (n+scale/2n)/scale;
const safe=(n:bigint):number|undefined=> n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):undefined;
export function historyMoney(value:unknown,minor=false,currency='EUR'):number|undefined {
  const d=decimal(value);if(!d)return undefined;
  if(minor&&d.n%d.scale!==0n)return undefined;
  let digits=2;try{digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;}catch{return undefined;}
  return safe(minor?d.n/d.scale:round(d.n*(10n**BigInt(digits)),d.scale));
}
export function historyHours(value:unknown):number|undefined {
  const d=decimal(value);if(!d||d.n===0n||d.n>1000000n*d.scale)return undefined;
  if(d.n*1000000n%d.scale!==0n)return undefined;
  return Number(d.n)/Number(d.scale);
}
export function workAmount(hours:unknown,rateMinor:number):number|undefined {
  const d=decimal(hours);if(!d||!Number.isSafeInteger(rateMinor)||rateMinor<0)return undefined;
  return safe(round(d.n*BigInt(rateMinor),d.scale));
}
function normalize(sheet:RawSheet,kind:'work'|'invoices',mapping:Record<string,string>,currency:string|undefined,statusMap:Record<string,HistoryStatus|''>) {
  const rows:PreviewRow[]=[];let skipped=0;
  for(const raw of sheet.rows) {
    if(raw.rowNumber<=sheet.headerRow)continue;
    const get=(key:string)=>mapping[key]?raw.columns[mapping[key]!]:undefined;
    // Formula-only blank template lines are archived, never materialized as records.
    const actual = ['date','studentName','hours','rateMinor','amountMinor','status','invoiceNumber','paidDate'].some(key=>{const v=get(key);return text(v).trim()&&!(v&&typeof v==='object'&&('formula' in v||'sharedFormula' in v));});
    if(!actual) {skipped++;continue;}
    const values:HistoryValues={}, errors:string[]=[], warnings:string[]=[];
    values.date=parseHistoryDate(get('date'));if(!values.date)errors.push('A valid date is required (YYYY-MM-DD or DD/MM/YYYY)');
    if(text(get('date')).includes('/'))warnings.push('Date interpreted as day/month/year');
    values.studentName=text(get('studentName')).trim();if(!values.studentName||values.studentName.length>200)errors.push('Student/payer name must contain 1–200 characters');
    values.serviceType=text(get('serviceType')).trim();if(values.serviceType.length>500)errors.push('Service type exceeds 500 characters');
    values.notes=text(get('notes')).trim();if(values.notes.length>4000)errors.push('Notes exceed 4,000 characters');
    values.currency=(text(get('currency')).trim()||currency)?.toUpperCase();if(!values.currency||!/^[A-Z]{3}$/.test(values.currency))errors.push('Choose a three-letter currency');
    const rawStatus=text(get('status')).trim();values.status=(statusMap[rawStatus]??Object.entries(statusMap).find(([label])=>label.toLowerCase()===rawStatus.toLowerCase())?.[1])||undefined;
    if(!rawStatus||!values.status)errors.push(rawStatus?`Review unknown status: ${rawStatus.slice(0,100)}`:'Review missing status');
    const paidDate=text(get('paidDate')).trim();if(paidDate){values.paidDate=parseHistoryDate(paidDate);if(!values.paidDate)errors.push('Paid date must be a valid date');if(values.status!=='paid')errors.push('Paid date is only valid for a paid declaration');}
    const invoiceNumber=text(get('invoiceNumber')).trim();if(invoiceNumber){values.invoiceNumber=invoiceNumber;if(invoiceNumber.length>200)errors.push('Invoice number exceeds 200 characters');}
    const moneyIsMinor=(field:string)=>/minor/i.test(mapping[field]??'');
    const amountText=text(get('amountMinor')).trim();values.amountMinor=amountText?historyMoney(get('amountMinor'),moneyIsMinor('amountMinor'),values.currency):undefined;
    if(kind==='work') {
      values.hours=historyHours(get('hours'));if(values.hours===undefined)errors.push('Hours must be positive, at most 1,000,000, with at most six decimal places');
      values.rateMinor=historyMoney(get('rateMinor'),moneyIsMinor('rateMinor'),values.currency);if(values.rateMinor===undefined)errors.push('A nonnegative hourly rate within the exact range is required');
      const derived=values.hours!==undefined&&values.rateMinor!==undefined?workAmount(get('hours'),values.rateMinor):undefined;
      if(derived===undefined&&values.hours!==undefined&&values.rateMinor!==undefined)errors.push('Calculated total exceeds the exact range');
      if(!amountText&&derived!==undefined){values.amountMinor=derived;warnings.push('Missing total derived from hours × rate, rounded to nearest minor unit');}
      else if(derived!==undefined&&values.amountMinor!==undefined&&derived!==values.amountMinor)errors.push('Source total conflicts with hours × hourly rate');
      else if(derived!==undefined&&decimal(get('hours'))!.n*BigInt(values.rateMinor!)%decimal(get('hours'))!.scale!==0n)warnings.push('Fractional-hour total rounded to nearest minor unit');
    }
    if(values.amountMinor===undefined)errors.push('A nonnegative total within the exact range is required');
    rows.push({rowNumber:raw.rowNumber,values,errors,warnings});
  }
  return {rows,skipped};
}
export async function parseHistoryFile(fileName:string,bytes:Buffer,options:HistoryOptions):Promise<{preview:HistoryPreview;rawSource:{sheets:RawSheet[]};contentType:string}> {
  if(!bytes.length||bytes.length>MAX_HISTORY_BYTES)fail('File must contain data and be at most 5 MB');
  fileName=fileName.replace(/^.*[\\/]/,'').replace(/[\x00-\x1f\x7f]/g,'').slice(0,200)||'source';
  let sheets:RawSheet[]=[],contentType:string;
  if(/\.pdf$/i.test(fileName)){if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))fail('PDF must have a valid PDF signature');contentType='application/pdf';}
  else if(/\.csv$/i.test(fileName)){sheets=[csvSheet(bytes)];contentType='text/csv';}
  else if(/\.xlsx$/i.test(fileName)) {
    await validateWorkbookArchive(bytes);contentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const book=new ExcelJS.Workbook();try{await book.xlsx.load(bytes as unknown as Parameters<typeof book.xlsx.load>[0]);}catch{fail('XLSX workbook could not be read');}
    if(book.worksheets.length>20)fail('At most 20 worksheets are supported');
    let totalCells=0;
    sheets=book.worksheets.map(sheet=>{
      if(sheet.rowCount>2001||sheet.columnCount>100)fail('Workbook exceeds 2,000 rows or 100 columns per sheet');
      totalCells+=sheet.rowCount*sheet.columnCount;if(totalCells>200000)fail('Workbook exceeds the total cell limit');
      return rawSheet(sheet.name,Array.from({length:sheet.rowCount},(_,i)=>({rowNumber:i+1,values:Array.from({length:sheet.columnCount},(_,j)=>sheet.getRow(i+1).getCell(j+1).value)})));
    });
  } else return fail('Choose a CSV, XLSX or PDF file');
  if(options.sheetName&&!sheets.some(sheet=>sheet.name===options.sheetName))fail('Selected worksheet does not exist');
  const candidate=(sheet:RawSheet)=>{const m=inferredMapping(sheet.headers);return !!(m.date&&m.studentName&&(m.hours||m.amountMinor));};
  const selected=options.sheetName?sheets.find(s=>s.name===options.sheetName):(sheets.find(candidate)??sheets[0]);
  const mapping={...inferredMapping(selected?.headers??[]),...options.mapping} as Record<string,string>;
  for(const key of Object.keys(mapping))if(mapping[key]==='')delete mapping[key];
  if(selected&&Object.values(mapping).some(header=>!selected.headers.includes(header)))fail('Mapped column does not exist in the selected sheet');
  const kind=options.kind==='archive'||!sheets.length?'archive':options.kind==='auto'?(mapping.hours?'work':mapping.amountMinor?'invoices':'archive'):options.kind;
  const statusMap:Record<string,HistoryStatus|''>={Paid:'paid',Sent:'pending',Pending:'unsent',paid:'paid',pending:'pending',unsent:'unsent',...options.statusMap};
  // Preserve the legacy label Pending -> unsent even though canonical pending means sent.
  const currency=options.currency??(selected?.headers.some(h=>/€|\bEUR\b/i.test(h))?'EUR':undefined);
  const warnings=['Paid statuses are historical declarations, not verified payment transactions','Rows containing only templates or unmapped columns are preserved in the source archive'];
  if(kind!=='archive'&&!selected)fail('Choose a data sheet and column mapping; no data sheet was identified');
  let rows:PreviewRow[]=[],skipped=0;
  if(kind!=='archive'&&selected) {
    if(!mapping.date||!mapping.studentName||kind==='work'&&(!mapping.hours||!mapping.rateMinor)) {
      warnings.push('Required columns are unmapped; review column mapping before committing');
    }
    const result=normalize(selected,kind,mapping,currency,statusMap);rows=result.rows;skipped=result.skipped;
  }
  if(sheets.length>1)warnings.push('Only the selected data sheet is normalized; other sheets are preserved in the archive');
  if(kind==='archive')warnings.push('Archive only: no work or invoice records will be created');
  const preview:HistoryPreview={kind,fileName,sheetName:selected?.name??null,sheets:sheets.map(({name,headers,rowCount})=>({name,headers,rowCount})),headers:selected?.headers??[],mapping,statusMap,rows,summary:{valid:rows.filter(r=>!r.errors.length).length,invalid:rows.filter(r=>r.errors.length).length,skipped},warnings};
  return {preview,rawSource:{sheets},contentType};
}
