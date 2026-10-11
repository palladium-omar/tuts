import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedRead, createApi, onApiInvalidation } from '../lib/api';
import { studentReviewCounts, suggestedStudentDecision, workGroupKey } from '../lib/work-import-students';
import { createHash } from 'node:crypto';

const rows = [{ id: 'b', identity: {status:'unreviewed'} }, {id:'a', identity:{status:'linked'}}];
test('work import suggestions support missing contact details but never pick ambiguous names', () => {
  assert.deepEqual(suggestedStudentDecision({ rows, candidates: [] }), {action:'create',rowIds:['b']});
  assert.deepEqual(suggestedStudentDecision({ rows, candidates:[{id:'student'}] }), {action:'link',studentId:'student',rowIds:['b']});
  assert.equal(suggestedStudentDecision({ rows, candidates:[{id:'one'},{id:'two'}] }).action,'skip');
  assert.equal(suggestedStudentDecision({ rows, candidates:[{id:'one'}],ambiguous:true }).action,'skip');
});
test('reopening interrupted creation preserves the saved create action and row selection', () => {
  assert.deepEqual(suggestedStudentDecision({rows,resolvedStudentId:'student',resolvedAction:'create'}),{action:'create',rowIds:['b']});
  assert.deepEqual(suggestedStudentDecision({rows,resolvedStudentId:'student',resolvedAction:'link'}),{action:'link',studentId:'student',rowIds:['b']});
  const saved={key:'key',rows,resolvedStudentId:'student',resolvedAction:'create'};
  assert.deepEqual(studentReviewCounts([saved],{key:suggestedStudentDecision(saved)}),{created:0,linked:1,rows:1,skipped:0});
});
test('review can split a source name by selected work rows and keys match Billing', async () => {
  const group={key:'key',rows};
  assert.deepEqual(studentReviewCounts([group],{key:{action:'create',rowIds:['b']}}),{created:1,linked:0,rows:1,skipped:0});
  assert.equal(await workGroupKey(['B','a']),createHash('sha256').update('a\nb').digest('hex'));
  assert.equal(await workGroupKey(['a','b']),await workGroupKey(['B','A']));
});
test('student resolution invalidates Clients and Reporting along with owned Billing reads', () => {
  const mutation='billing/v1/history-imports/source-id/students';
  for(const read of ['clients/v1/clients','clients/v1/groups','billing/v1/business-analytics','reporting/v1/business-dashboard']) assert.equal(affectedRead(mutation,read),true);
  assert.equal(affectedRead('billing/v1/history-imports/commit','clients/v1/clients'),false);
  assert.equal(affectedRead(mutation,'planning/v1/boards'),false);
});
test('invalidation subscriptions can detach without retaining mounted dashboard handlers', async () => {
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({item:{}});
  try { const api=createApi('business');let calls=0;const off=onApiInvalidation(api,()=>{calls++;});await api('billing/v1/history-imports/import/students','POST',{});assert.equal(calls,2);off();await api('billing/v1/history-imports/import/students','POST',{});assert.equal(calls,2); }
  finally {globalThis.fetch=savedFetch;}
});
