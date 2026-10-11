import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {ApiError,type Api} from '../lib/api';
import {createHomeworkWorkGuard,homeworkLink,withoutAssignment,loadLinkedHomework,homeworkOpenError,portalUuid} from '../app/portal/homework-navigation';
import {emailReminderLabel,reminderError,reminderPath,reminderPresets,reminderTime} from '../app/portal/reminder-model';
import {studentSessionStatus,studentSessionStatusLabel} from '../app/portal/session-model';
import {overviewLink} from '../app/portal/overview-model';
const student='11111111-1111-4111-8111-111111111111',assignment='22222222-2222-4222-8222-222222222222';

test('homework navigation preserves business, selects the exact assignment and clears planning parameters',()=>{
 const href=homeworkLink('https://tuts.test/portal?business=tenant&section=planning&board=old&card=old#work',student,assignment)!;
 const url=new URL(href,'https://tuts.test');
 assert.equal(url.searchParams.get('business'),'tenant');assert.equal(url.searchParams.get('student'),student);assert.equal(url.searchParams.get('assignment'),assignment);assert.equal(url.searchParams.get('section'),'homework');assert.equal(url.searchParams.has('board'),false);assert.equal(url.searchParams.has('card'),false);assert.equal(url.hash,'#work');
 const closed=new URL(withoutAssignment(url.href),'https://tuts.test');assert.equal(closed.searchParams.has('assignment'),false);assert.equal(closed.searchParams.get('student'),student);assert.equal(closed.searchParams.get('section'),'homework');
 const planning=new URL(overviewLink(url.href,student,'planning','board','card'),'https://tuts.test');assert.equal(planning.searchParams.has('assignment'),false);
 assert.match(homeworkLink('https://tuts.test/?business=tenant',student,assignment)!,/^\/portal\?/);
 for(const bad of ['../other','abc','javascript:alert(1)','',null]){assert.equal(portalUuid(bad),false);assert.equal(homeworkLink(url.href,student,bad as string),null);}
});

test('deep homework reads detail independently of filtered or paged list and checks canonical student',async()=>{
 const calls:unknown[][]=[];const api:Api=async(...args)=>{calls.push(args);return {item:{id:assignment,clientId:student,status:'completed'}};};
 const signal=new AbortController().signal;const row=await loadLinkedHomework(api,student,assignment,signal);
 assert.equal(row.status,'completed');assert.equal(calls.length,1);assert.equal(calls[0]![0],`learning/v1/portal/assignments/${assignment}`);assert.deepEqual(calls[0]![4],{fresh:true,signal});
 const wrong:Api=async()=>({item:{id:assignment,clientId:'33333333-3333-4333-8333-333333333333',title:'Private'}});
 await assert.rejects(loadLinkedHomework(wrong,student,assignment,signal),(e:unknown)=>e instanceof ApiError&&e.status===404);
 await assert.rejects(loadLinkedHomework(api,student,'invalid',signal),/invalid/);assert.equal(calls.length,1);
});

test('stale linked assignment responses never open after cancellation or student change',async()=>{
 let resolve!:(data:unknown)=>void;const api:Api=()=>new Promise(done=>{resolve=done;});
 const controller=new AbortController();const request=loadLinkedHomework(api,student,assignment,controller.signal);
 controller.abort();resolve({item:{id:assignment,clientId:student,title:'Stale'}});
 await assert.rejects(request,(e:unknown)=>e instanceof Error&&e.name==='AbortError');
});

test('deep-link and reminder errors use scoped safe retry messages',()=>{
 for(const status of [401,403,404]){const error=new ApiError('Private assignment title or server detail',status);assert.match(homeworkOpenError(error),/unavailable.*access/);assert.doesNotMatch(homeworkOpenError(error),/Private/);assert.match(reminderError(error),/unavailable.*access/);}
 assert.match(homeworkOpenError(new Error('upstream failure')),/retry/);assert.match(reminderError(new ApiError('duplicate',409)),/already exists/);assert.match(reminderError(new ApiError('sender unavailable',503)),/temporarily unavailable/);
});

test('reminder presets omit past day-before dates and reminders require bounded future times',()=>{
 const now=Date.parse('2026-10-11T10:00:00Z');
 assert.equal(reminderPresets('2026-10-11T12:00:00Z',now).length,1);
 const presets=reminderPresets('2026-10-15T12:00:00Z',now);assert.equal(presets.length,2);assert.equal(presets[1]!.instant,'2026-10-14T12:00:00.000Z');
 assert.equal(reminderTime('2026-10-11T11:00:00Z',now),'2026-10-11T11:00:00.000Z');
 for(const value of ['invalid','2026-10-11T10:00:30Z','2026-10-10T11:00:00Z','2027-10-12T11:00:00Z'])assert.throws(()=>reminderTime(value,now),/at least one minute/);
});

test('reminder links are rebuilt from validated identities and cannot use arbitrary outbound URLs',()=>{
 const row={studentId:student,targetKind:'homework',assignmentId:assignment,portalPath:'https://evil.test'};
 const url=new URL(reminderPath(row,student,'tenant')!,'https://tuts.test');assert.equal(url.origin,'https://tuts.test');assert.equal(url.searchParams.get('assignment'),assignment);assert.equal(url.searchParams.get('business'),'tenant');
 assert.equal(reminderPath({...row,studentId:assignment},student,'tenant'),null);assert.equal(reminderPath({...row,assignmentId:'bad'},student,'tenant'),null);
 const planning=new URL(reminderPath({studentId:student,targetKind:'planning',boardId:assignment,cardId:student},student,'tenant')!,'https://tuts.test');assert.equal(planning.searchParams.get('card'),student);
});

test('email delivery wording distinguishes sender acceptance from delivery and supports unavailable email',()=>{
 assert.equal(emailReminderLabel({emailEnabled:false,emailStatus:'pending'}),'In-app reminder');assert.match(emailReminderLabel({emailEnabled:true,emailStatus:'accepted'}),/accepted by sender/);assert.doesNotMatch(emailReminderLabel({emailEnabled:true,emailStatus:'accepted'}),/delivered/);
 for(const emailStatus of ['failed','unknown','disabled'])assert.match(emailReminderLabel({emailEnabled:true,emailStatus}),/in-app reminder/i);
});


test('assignment links explicitly carry the owning business even when the current route omits or selects another business',()=>{
 for (const current of ['https://tuts.test/?view=students', 'https://tuts.test/?business=other']) {
   const url=new URL(homeworkLink(current,student,assignment,'owning-business')!,'https://tuts.test');
   assert.equal(url.pathname,'/portal');assert.equal(url.searchParams.get('business'),'owning-business');assert.equal(url.searchParams.get('student'),student);assert.equal(url.searchParams.get('assignment'),assignment);
 }
});

test('submission and upload completion tickets are invalidated by navigation, including reactivation',async()=>{
 const guard=createHomeworkWorkGuard();guard.activate();const original=guard.ticket();
 let resolve!:(value:unknown)=>void;const pending=new Promise(done=>{resolve=done;});
 let uploaded=0,submitted=0,closed=0;
 const upload=pending.then(()=>{if(!original())return;uploaded++;submitted++;closed++;});
 guard.deactivate();guard.activate();const current=guard.ticket();
 resolve({id:'old upload'});await upload;
 assert.equal(uploaded,0);assert.equal(submitted,0);assert.equal(closed,0);assert.equal(original(),false);assert.equal(current(),true);
 guard.deactivate();assert.equal(current(),false);
});


test('session booking pages do not claim to provide verified per-booking management',async()=>{
 const source=await readFile(new URL('../app/portal/page.tsx',import.meta.url),'utf8');
 assert.match(source,/Open Cal.com booking page/);
 assert.match(source,/To change or cancel a booking, use the management links in your Cal.com confirmation email/);
 assert.doesNotMatch(source,/Manage booking in Cal.com|Need to change a booking\? Open its Cal.com link above/);
});


test('student booking cancellation overrides presentation without changing tutor attendance',()=>{
 for (const status of ['scheduled','completed','no_show']) {
   const row={source:'calcom',status,providerStatus:'cancelled'};
   assert.equal(studentSessionStatus(row),'cancelled');assert.equal(studentSessionStatusLabel(row),'Cancelled');assert.equal(row.status,status);
 }
 for (const status of ['scheduled','completed','cancelled','no_show']) {
   assert.equal(studentSessionStatus({status}),status);assert.equal(studentSessionStatus({status,providerStatus:'accepted'}),status);
 }
});

test('overview reminder success refreshes the scoped inbox without restarting domain summaries',async()=>{
 const overview=await readFile(new URL('../app/portal/portal-overview.tsx',import.meta.url),'utf8');
 const reminders=await readFile(new URL('../app/portal/portal-reminders.tsx',import.meta.url),'utf8');
 assert.match(overview,/ReminderInbox key=\{studentId\}.*reloadToken=\{reminderRevision\}/);
 assert.match(overview,/ReminderControl.*onChanged=\{\(\)=>setReminderRevision\(n=>n\+1\)\}/);
 assert.match(reminders,/setExpanded\(false\);setEmailEnabled\(false\);onChanged\?\.\(\)/);
 assert.match(reminders,/\[api,studentId,offset,revision,reloadToken\]/);
 assert.match(overview,/\[api,studentId,coverage\]/);
});
