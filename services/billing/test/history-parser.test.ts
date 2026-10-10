import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { historyHours, historyMoney, historyOptionsSchema, parseHistoryFile, parseHistoryDate, workAmount } from '../src/history-parser.js';

const options=historyOptionsSchema.parse({kind:'work'});
const csv=(rows:string)=>Buffer.from('Date,Student Name,Service Type,Hours Worked,Hourly Rate (€),Total (€),Invoice Status,Notes\n'+rows);

test('Work CSV preserves raw unknown columns and uses exact fractional hours with explicit legacy status mapping',async()=>{
  const parsed=await parseHistoryFile('work.csv',csv('2026-09-03,Synthetic learner,Lesson,1.5,40,60,Paid,review\n2026-09-04,Synthetic learner,Coaching,0.25,15,,Sent,missing total\n2026-09-05,Other learner,Lesson,2,40,80,Pending,note\n'),options);
  assert.deepEqual(parsed.preview.summary,{valid:3,invalid:0,skipped:0});
  assert.equal(parsed.preview.rows[0]!.values.amountMinor,6000);
  assert.equal(parsed.preview.rows[0]!.values.status,'paid');
  assert.equal(parsed.preview.rows[1]!.values.status,'pending');
  assert.equal(parsed.preview.rows[2]!.values.status,'unsent');
  assert.equal(parsed.preview.rows[1]!.values.amountMinor,375);
  assert.match(parsed.preview.rows[1]!.warnings[0]!,/Missing total/);
  assert.equal(parsed.rawSource.sheets[0]!.rows[1]!.columns.Notes,'review');
});
test('Unknown status, impossible date, conflicting total and blank-status rows stay invalid for explicit review',async()=>{
  const parsed=await parseHistoryFile('work.csv',csv('2026-02-30,A,Lesson,1.5,40,70,Maybe,note\n2026-09-04,B,Lesson,1,15,15,,note'),options);
  assert.deepEqual(parsed.preview.summary,{valid:0,invalid:2,skipped:0});
  assert.match(parsed.preview.rows[0]!.errors.join(' '),/valid date.*unknown status.*conflicts/);
  assert.equal(parsed.preview.rows[1]!.values.status,undefined);
  assert.match(parsed.preview.rows[1]!.errors.join(' '),/missing status/);
});
test('Explicit mapping, semicolon decimal commas, currency and status overrides are honored',async()=>{
  const parsed=await parseHistoryFile('mapped.csv',Buffer.from('When;Who;Duration;Price;Money;State;Extra\n04/09/2026;Synthetic;1,5;10,5;15,75;Approved;=UNTRUSTED()'),historyOptionsSchema.parse({kind:'work',currency:'GBP',mapping:{date:'When',studentName:'Who',hours:'Duration',rateMinor:'Price',amountMinor:'Money',status:'State'},statusMap:{Approved:'paid'}}));
  assert.equal(parsed.preview.rows[0]!.values.date,'2026-09-04');
  assert.equal(parsed.preview.rows[0]!.values.amountMinor,1575);
  assert.equal(parsed.preview.rows[0]!.values.currency,'GBP');
  assert.equal(parsed.rawSource.sheets[0]!.rows[1]!.columns.Extra,'=UNTRUSTED()');
});
test('XLSX chooses the data sheet, preserves formula caches and all sheets, and skips formula-only templates',async()=>{
  const book=new ExcelJS.Workbook();
  const summary=book.addWorksheet('Calculated overview');summary.addRow(['Student Name','Total (€)']);summary.addRow(['Synthetic',{formula:'SUM(HoursLog!F2:F4)',result:75}]);
  const sheet=book.addWorksheet('HoursLog');sheet.addRow(['Date','Student Name','Service Type','Hours Worked','Hourly Rate (€)','Total (€)','Invoice Status','Notes']);
  sheet.addRow([new Date('2026-09-03T00:00:00Z'),'Synthetic','Lesson',1.5,40,{formula:'D2*E2',result:60},'Paid','']);
  sheet.addRow([new Date('2026-09-04T00:00:00Z'),'Synthetic','Lesson',1,15,{formula:'D3*E3'},'Sent','']);
  sheet.getCell('C4').value='Lesson';sheet.getCell('F4').value={formula:'D4*E4'};
  sheet.getCell('F585').value={formula:'D585*E585',result:0};
  const bytes=Buffer.from(await book.xlsx.writeBuffer());
  const parsed=await parseHistoryFile('synthetic.xlsx',bytes,options);
  assert.equal(parsed.preview.sheetName,'HoursLog');assert.equal(parsed.preview.sheets.length,2);
  assert.equal(parsed.preview.summary.valid,2);assert.equal(parsed.preview.rows.length,2);
  assert.equal(parsed.preview.rows[1]!.values.amountMinor,1500);
  assert.deepEqual(parsed.rawSource.sheets[1]!.rows[1]!.columns['Total (€)'],{formula:'D2*E2',result:60});
  assert.equal(parsed.rawSource.sheets[1]!.rows.length,585);
  const chosen=await parseHistoryFile('synthetic.xlsx',bytes,historyOptionsSchema.parse({kind:'work',sheetName:'Calculated overview'}));
  assert.equal(chosen.preview.summary.valid,0);assert.equal(chosen.preview.summary.invalid,1);
});
test('Money and derived totals use safe integer rounding with range rejection',()=>{
  assert.equal(historyMoney('0.005'),1);assert.equal(historyMoney('1500',false,'JPY'),1500);assert.equal(historyMoney('1.234',false,'KWD'),1234);assert.equal(workAmount('0.125',101),13);
  assert.equal(historyMoney('90071992547409.92'),undefined);
  assert.equal(workAmount('1000000',Number.MAX_SAFE_INTEGER),undefined);
  assert.equal(historyMoney('1.2',true),undefined);assert.equal(historyHours('0.1234567'),undefined);
  assert.equal(historyHours('0.000001'),0.000001);assert.equal(parseHistoryDate('2026-02-29'),undefined);
  assert.equal(historyMoney('-5'),undefined);assert.equal(historyMoney('NaN'),undefined);
});
test('PDF is archive-only and unsafe or malformed formats are rejected',async()=>{
  const result=await parseHistoryFile('invoice.pdf',Buffer.from('%PDF-1.7\nSynthetic archive'),historyOptionsSchema.parse({kind:'invoices'}));
  assert.equal(result.preview.kind,'archive');assert.equal(result.preview.rows.length,0);
  await assert.rejects(()=>parseHistoryFile('invoice.pdf',Buffer.from('not pdf'),options),/PDF signature/);
  await assert.rejects(()=>parseHistoryFile('work.xlsx',Buffer.from('not zip'),options),/unencrypted workbook/);
  await assert.rejects(()=>parseHistoryFile('work.csv',Buffer.from([0xff]),options),/UTF-8/);
  await assert.rejects(()=>parseHistoryFile('work.xls',Buffer.from('x'),options),/CSV, XLSX or PDF/);
});

test('Explicit blank mapping and status choices override inferred columns without creating records',async()=>{
 const parsed=await parseHistoryFile('work.csv',csv('2026-09-03,Synthetic,Lesson,1,40,40,Paid,note'),historyOptionsSchema.parse({kind:'work',mapping:{hours:''},statusMap:{Paid:''}}));
 assert.equal(parsed.preview.mapping.hours,undefined);assert.equal(parsed.preview.statusMap.Paid,'');assert.equal(parsed.preview.summary.valid,0);assert.match(parsed.preview.rows[0]!.errors.join(' '),/status/);
});

test('Sparse workbook dimensions are bounded before loading the archive',async()=>{
 const book=new ExcelJS.Workbook();book.addWorksheet('Huge').getCell('A2002').value='Synthetic';
 const bytes=Buffer.from(await book.xlsx.writeBuffer());
 await assert.rejects(()=>parseHistoryFile('oversize.xlsx',bytes,options),/rows|dimensions/);
});
