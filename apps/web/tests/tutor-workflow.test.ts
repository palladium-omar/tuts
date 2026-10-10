import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contactDisplayName, readContactLocation, readTrackerLocation, tutorHomeworkOrder, tutorLocation} from '../lib/tutor-workspace';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StudentSubmission, submittedWorkLink} from '../components/student-submission';
import {canReadFinancial, hasPermission} from '@palladium/contracts';
const business = '11111111-1111-4111-8111-111111111111', student = '22222222-2222-4222-8222-222222222222', group = '33333333-3333-4333-8333-333333333333';
test('name corrections update generated display names and preserve explicit nicknames', () => {
  const original = {firstName:'Maya',lastName:'Sample',displayName:'Maya Sample'};
  assert.equal(contactDisplayName(original,'Maya','Patel','Maya Sample'),'Maya Patel');
  assert.equal(contactDisplayName({...original,displayName:'May'},'Maya','Patel','May'),'May');
  assert.equal(contactDisplayName(original,'Maya','Patel','Maya P.'),'Maya P.');
  assert.equal(contactDisplayName(original,'Maya','Patel',''),'Maya Patel');
  assert.equal(contactDisplayName(null,' Maya ',' Patel ',''),'Maya Patel');
});
test('tracker navigation accepts valid IDs only in the current business and section', () => {
  const params = new URLSearchParams({business,view:'tracker',group,student,trackerTab:'documents',trackerView:'all'});
  assert.deepEqual(readTrackerLocation(params,business),{view:'all',groupId:group,studentId:student,tab:'documents'});
  assert.equal(readTrackerLocation(params,student).studentId,null);
  params.set('view','clients'); assert.equal(readTrackerLocation(params,business).groupId,null);
  params.set('view','tracker'); params.set('group','not-an-id'); params.set('student','https://other.example'); params.set('trackerTab','admin');
  assert.deepEqual(readTrackerLocation(params,business),{view:'all',groupId:null,studentId:null,tab:'summary'});
});
test('cross-workspace navigation removes stale child locations and preserves same-view context', () => {
  const original = new URLSearchParams({business,view:'tracker',group,student,trackerTab:'documents',trackerView:'groups'});
  const same = tutorLocation(original,business,'tracker',{student:null,trackerTab:null});
  assert.equal(same.get('group'),group); assert.equal(same.get('student'),null);
  const crm = tutorLocation(original,business,'clients',{contact:student});
  assert.equal(readContactLocation(crm,business),student); assert.equal(crm.get('group'),null); assert.equal(crm.get('trackerTab'),null);
  assert.equal(readContactLocation(crm,group),null);
  const other = tutorLocation(original,group,'tracker',{}); assert.equal(other.get('student'),null); assert.equal(other.get('group'),null);
  assert.equal(original.get('group'),group);
});
test('tutor homework puts submissions needing review ahead of completed work without mutating input', () => {
  const rows = [{title:'Finished',status:'completed',dueAt:'2026-10-01'}, {title:'Later',status:'submitted',dueAt:'2026-10-20'}, {title:'Sooner',status:'submitted',dueAt:'2026-10-12'}, {title:'Draft',status:'assigned',dueAt:null}];
  assert.deepEqual(tutorHomeworkOrder(rows).map(row=>row.title),['Sooner','Later','Draft','Finished']);
  assert.equal(rows[0].title,'Finished');
});
test('tutor review presents file-only and link-only student submissions', () => {
  const file = renderToStaticMarkup(createElement(StudentSubmission,{assignment:{submissionResources:[{id:student,fileName:'answer.pdf',storageStatus:'stored'}]},onDownload:()=>{}}));
  assert.match(file,/Student work/); assert.match(file,/Download submitted answer.pdf/); assert.doesNotMatch(file,/disabled/);
  const link = renderToStaticMarkup(createElement(StudentSubmission,{assignment:{submissionUrl:'https://docs.google.com/document/d/example/edit'},onDownload:()=>{}}));
  assert.match(link,/Open submitted work/);
  assert.equal(submittedWorkLink('javascript:alert(1)'),null); assert.equal(submittedWorkLink('https://user:password@example.com'),null);
  assert.equal(renderToStaticMarkup(createElement(StudentSubmission,{assignment:{},onDownload:()=>{}})),'');
});
test('tutor finances follow provisioned capabilities rather than the tutor label', () => {
  const teaching = {role:'tutor',permissions:['clients.read','learning.read','learning.write','reporting.read']};
  assert.equal(hasPermission(teaching,'clients.read'),true); assert.equal(hasPermission(teaching,'learning.write'),true);
  assert.equal(canReadFinancial(teaching),false); assert.equal(hasPermission(teaching,'billing.read'),false);
  assert.equal(canReadFinancial({...teaching,permissions:[...teaching.permissions,'billing.read','reporting.financial']}),true);
});
