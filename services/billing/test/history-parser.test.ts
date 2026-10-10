import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { historyHours, historyMoney, historyOptionsSchema, parseHistoryFile, parseHistoryDate, workAmount } from '../src/history-parser.js';

const options=historyOptionsSchema.parse({kind:'work'});
const csv=(rows:string)=>Buffer.from('Date,Student Name,Service Type,Hours Worked,Hourly Rate (€),Total (€),Invoice Status,Notes\n'+rows);

test('Work CSV preserves raw unknown columns and uses exact fractional hours with consistent status defaults',async()=>{
  const parsed=await parseHistoryFile('work.csv',csv('2026-09-03,Synthetic learner,Lesson,1.5,40,60,Paid,review\n2026-09-04,Synthetic learner,Coaching,0.25,15,,Sent,missing total\n2026-09-05,Other learner,Lesson,2,40,80,Pending,note\n'),options);
  assert.deepEqual(parsed.preview.summary,{valid:3,invalid:0,skipped:0});
  assert.equal(parsed.preview.rows[0]!.values.amountMinor,6000);
  assert.equal(parsed.preview.rows[0]!.values.status,'paid');
  assert.equal(parsed.preview.rows[1]!.values.status,'pending');
  assert.equal(parsed.preview.rows[2]!.values.status,'pending');
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

test('Statuses group only observed variants using case, Unicode spacing and NFKC normalization',async()=>{
  const labels=['pending','Pending',' PENDING ','\u00a0Pending\u00a0','Ｐｅｎｄｉｎｇ','Sent','Unpaid','Outstanding','Unsent','Draft','not_sent','NOT-SENT','not\u00a0 sent','Paid','settled','Approved','Part paid'];
  const source=csv(labels.map(label=>`2026-09-03,Synthetic,Lesson,1,40,40,${label},`).join('\n'));
  const {preview,rawSource}=await parseHistoryFile('variants.csv',source,options);
  assert.deepEqual(preview.summary,{valid:15,invalid:2,skipped:0});
  assert.deepEqual(preview.rows.map(row=>row.values.status),['pending','pending','pending','pending','pending','pending','pending','pending','unsent','unsent','unsent','unsent','unsent','paid','paid',undefined,undefined]);
  assert.deepEqual(preview.statusLabels[0],{key:'pending',labels:labels.slice(0,5),count:5,status:'pending'});
  assert.deepEqual(preview.statusLabels.find(group=>group.key==='not sent'),{key:'not sent',labels:labels.slice(10,13),count:3,status:'unsent'});
  assert.deepEqual(preview.statusLabels.find(group=>group.key==='approved'),{key:'approved',labels:['Approved'],count:1,status:null});
  assert.equal(preview.statusLabels.some(group=>group.key==='payment received'),false);
  assert.equal(rawSource.sheets[0]!.rows[4]!.columns['Invoice Status'],'\u00a0Pending\u00a0');
});

test('One explicit override applies to every normalized spelling including custom and blank choices',async()=>{
  const {preview}=await parseHistoryFile('overrides.csv',csv('2026-09-03,A,Lesson,1,40,40,pending,\n2026-09-03,B,Lesson,1,40,40, PENDING ,\n2026-09-03,C,Lesson,1,40,40,review_required,\n2026-09-03,D,Lesson,1,40,40, REVIEW-REQUIRED ,\n2026-09-03,E,Lesson,1,40,40,PAID,'),historyOptionsSchema.parse({kind:'work',statusMap:{' Pending ':'unsent','Review required':'paid',Paid:''}}));
  assert.deepEqual(preview.rows.map(row=>row.values.status),['unsent','unsent','paid','paid',undefined]);
  assert.equal(preview.statusMap.Pending,'unsent');assert.equal(preview.statusMap.pending,'unsent');
  assert.equal(preview.statusMap.paid,'');assert.equal(preview.statusMap.Paid,'');
  assert.deepEqual(preview.statusLabels.map(group=>[group.key,group.count,group.status]),[['pending',2,'unsent'],['review required',2,'paid'],['paid',1,null]]);
});

test('Conflicting normalized explicit overrides fail clearly while identical overrides are allowed',async()=>{
  const source=csv('2026-09-03,A,Lesson,1,40,40,Pending,');
  for(const statusMap of [{Pending:'unsent',pending:'pending'},{'Review_required':'paid','review-required':'pending'},{Paid:'paid','\u00a0ＰＡＩＤ ':''}] as const) {
    await assert.rejects(()=>parseHistoryFile('conflict.csv',source,historyOptionsSchema.parse({kind:'work',statusMap})),error=>error instanceof Error&&error.name==='BadRequestException'&&/Conflicting status overrides.*same source status/.test(error.message));
  }
  const {preview}=await parseHistoryFile('same.csv',source,historyOptionsSchema.parse({kind:'work',statusMap:{Pending:'unsent',' PENDING ':'unsent'}}));
  assert.equal(preview.rows[0]!.values.status,'unsent');
});

test('Exact normalized header aliases recognize separators, Unicode spaces and monetary decorations',async()=>{
  for(const studentHeader of ['Student Name','student_name','FULL-NAME','student\u00a0 name','Ｓｔｕｄｅｎｔ　Ｎａｍｅ']) {
    const {preview}=await parseHistoryFile('headers.csv',Buffer.from(`work_date,${studentHeader},hours_worked,hourly_rate (GBP),total [GBP],invoice_status\n2026-09-03,Synthetic,1,GBP 40,40 GBP,Pending`),options);
    assert.equal(preview.mapping.studentName,studentHeader);assert.equal(preview.mapping.rateMinor,'hourly_rate (GBP)');
    assert.deepEqual(preview.summary,{valid:1,invalid:0,skipped:0});assert.equal(preview.rows[0]!.values.amountMinor,4000);
    assert.equal(preview.detectedCurrency,'GBP');assert.equal(preview.currencyColumn,null);assert.deepEqual(preview.currencyVariants,[]);
  }
  const {preview}=await parseHistoryFile('unmatched.csv',Buffer.from('Date,Potential student name,Hours,Possible hourly rate (GBP),Total (GBP),Status\n2026-09-03,Synthetic,1,40,40,Paid'),options);
  assert.equal(preview.mapping.studentName,undefined);assert.equal(preview.mapping.rateMinor,undefined);assert.equal(preview.summary.valid,0);
});

test('Currency header hints are unambiguous and explicit currency supplies or replaces the fallback',async()=>{
  for(const [decoration,currency] of [['€','EUR'],['EUR','EUR'],['£','GBP'],['GBP','GBP'],['USD','USD']] as const) {
    const source=Buffer.from(`Date,Full name,Hours,Hourly Rate (${decoration}),Total (${decoration}),Status\n2026-09-03,Synthetic,1,40,40,Paid`);
    const {preview}=await parseHistoryFile('currency.csv',source,options);
    assert.equal(preview.detectedCurrency,currency);assert.equal(preview.rows[0]!.values.currency,currency);assert.equal(preview.summary.valid,1);
    const overridden=await parseHistoryFile('currency.csv',source,historyOptionsSchema.parse({kind:'work',currency:'CAD'}));
    assert.equal(overridden.preview.detectedCurrency,currency);assert.equal(overridden.preview.rows[0]!.values.currency,'CAD');assert.equal(overridden.preview.mapping.currency,undefined);
  }
  for(const source of [Buffer.from('Date,Name,Hours,Rate ($),Total ($),Status\n2026-09-03,Synthetic,1,40,40,Paid'),Buffer.from('Date,Name,Hours,Rate (GBP),Total (USD),Status\n2026-09-03,Synthetic,1,40,40,Paid')]) {
    const {preview}=await parseHistoryFile('uncertain.csv',source,options);
    assert.equal(preview.detectedCurrency,null);assert.equal(preview.rows[0]!.values.currency,undefined);assert.match(preview.rows[0]!.errors.join(' '),/currency/);
    const confirmed=await parseHistoryFile('uncertain.csv',source,historyOptionsSchema.parse({kind:'work',currency:'USD'}));
    assert.equal(confirmed.preview.summary.valid,1);
  }
});

test('Actual currency columns expose observed codes and take precedence over source fallback',async()=>{
  const source=Buffer.from('Date,Name,Hours,Rate (EUR),Total (EUR),Status,CURRENCY\n2026-09-03,A,1,40,40,Paid, usd \n2026-09-03,B,1,40,40,Pending,GBP\n2026-09-03,C,1,40,40,Draft,\n2026-09-03,D,1,40,40,Paid,USD');
  const {preview}=await parseHistoryFile('mixed.csv',source,historyOptionsSchema.parse({kind:'work',currency:'CAD'}));
  assert.equal(preview.detectedCurrency,'EUR');assert.equal(preview.currencyColumn,'CURRENCY');assert.deepEqual(preview.currencyVariants,['USD','GBP']);
  assert.deepEqual(preview.rows.map(row=>row.values.currency),['USD','GBP','CAD','USD']);assert.equal(preview.summary.valid,4);
  const uniform=await parseHistoryFile('mixed.csv',source,historyOptionsSchema.parse({kind:'work',currency:'CAD',mapping:{currency:''}}));
  assert.equal(uniform.preview.mapping.currency,undefined);assert.equal(uniform.preview.currencyColumn,'CURRENCY');assert.deepEqual(uniform.preview.currencyVariants,['USD','GBP']);
  assert.deepEqual(uniform.preview.rows.map(row=>row.values.currency),['CAD','CAD','CAD','CAD']);
});

test('Archive previews expose empty interpretation metadata without creating rows',async()=>{
  const {preview}=await parseHistoryFile('invoice.pdf',Buffer.from('%PDF-1.7\nSynthetic archive'),historyOptionsSchema.parse({kind:'archive'}));
  assert.deepEqual(preview.statusLabels,[]);assert.equal(preview.detectedCurrency,null);assert.equal(preview.currencyColumn,null);assert.deepEqual(preview.currencyVariants,[]);
});
