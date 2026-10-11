import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewLink,progressPercent} from '../app/portal/overview-model';
test('overview navigation preserves workspace and replaces student and board identity',()=>{
 assert.equal(overviewLink('https://tuts.test/portal?business=b&student=old&board=old&section=overview','new','planning','board'),'/portal?business=b&student=new&section=planning&board=board');
 assert.equal(new URL(overviewLink('https://tuts.test/portal?board=old','new','homework'),'https://tuts.test').searchParams.has('board'),false);
});
test('progress handles empty, partial and inconsistent counts',()=>{
 assert.equal(progressPercent(0,0),0);assert.equal(progressPercent(2,3),67);assert.equal(progressPercent(4,3),100);assert.equal(progressPercent(-1,3),0);
});

test('every overview entry and retry requests a fresh scoped summary',async()=>{
 const {fetchOverview}=await import('../app/portal/overview-model');
 const calls:unknown[][]=[];
 const api:import('../lib/api').Api=async(...args)=>{calls.push(args);return {summary:{completed:calls.length}};};
 for(const domain of ['learning','planning','scheduling'] as const) {
   const first=await fetchOverview(api,domain,'student id');
   const returning=await fetchOverview(api,domain,'student id');
   assert.ok(returning.summary.completed>first.summary.completed);
 }
 assert.equal(calls.length,6);
 for(const call of calls) {assert.deepEqual(call[4],{fresh:true});assert.match(String(call[0]),/overview\?studentId=student%20id$/);}
 assert.equal(calls[2]![0],'planning/v1/overview?studentId=student%20id');
});

test('planning task links select the exact board and card and other sections clear old card links',()=>{
 const exact=new URL(overviewLink('https://tuts.test/portal?business=b&board=old&card=old','s','planning','board','task'),'https://tuts.test');
 assert.equal(exact.searchParams.get('card'),'task');assert.equal(exact.searchParams.get('board'),'board');assert.equal(exact.searchParams.get('student'),'s');
 const homework=new URL(overviewLink(exact.href,'s','homework'),'https://tuts.test');assert.equal(homework.searchParams.has('card'),false);
});

test('planning deadlines read the domain deadline object and omit invalid dates',async()=>{
 const {planningDeadlineDate}=await import('../app/portal/overview-model');
 assert.equal(planningDeadlineDate({dueAt:'2026-10-12T12:00:00.000Z',kind:'suggested'}),'2026-10-12T12:00:00.000Z');
 for(const input of [null,{}, {dueAt:null},{dueAt:'bad'},'bad'])assert.equal(planningDeadlineDate(input),null);
});

test('overview deadline labels distinguish suggested, personal and official timing',async()=>{
 const {overviewDeadlineLabel}=await import('../app/portal/overview-model');
 const dueAt='2026-10-12T12:00:00.000Z',now=Date.parse('2026-10-11T12:00:00Z');
 const suggested=overviewDeadlineLabel({dueAt,kind:'personal',status:'requires_confirmation',timeZone:'UTC'},now)!;
 assert.match(suggested,/^Suggested target/);assert.match(suggested,/coming up$/);assert.doesNotMatch(suggested,/PM|AM|12:00/);
 assert.match(overviewDeadlineLabel({dueAt,kind:'personal',status:'user_set',timeZone:'UTC'},now)!,/^Personal deadline/);
 assert.match(overviewDeadlineLabel({dueAt,kind:'official',status:'verified',timeZone:'UTC'},now+2*86400000)!,/^Official deadline.*past due$/);
 assert.equal(overviewDeadlineLabel({dueAt:'bad'}),null);
});

test('priority tasks remain bounded and avoid duplicating upcoming deadline rows',async()=>{
 const {priorityPlanningTasks}=await import('../app/portal/overview-model');
 const tasks=Array.from({length:10},(_,id)=>({id}));
 assert.deepEqual(priorityPlanningTasks(tasks,[{id:0},{id:1}]).map(task=>task.id),[2,3,4,5,6]);
 assert.equal(priorityPlanningTasks([],[]).length,0);
});

test('overview invalidation refreshes only affected domains and latest response wins',async()=>{
 const {createOverviewLoader}=await import('../app/portal/overview-loader');
 type Domain=import('../app/portal/overview-model').OverviewDomain;
 type State=import('../app/portal/overview-loader').OverviewLoad;
 let notify:((matches:(path:string)=>boolean,reason?:'access'|'dispose')=>void)|undefined;
 const pending:{path:string;resolve:(data:unknown)=>void;reject:(error:unknown)=>void}[]=[];
 const api:import('../lib/api').Api=path=>new Promise((resolve,reject)=>pending.push({path,resolve,reject}));
 const states:Partial<Record<Domain,State>>={};let updates=0,detached=0;
 const loader=createOverviewLoader(api,['learning','planning','scheduling'],'student',(domain,state)=>{states[domain]=state;updates++;},String,(_api,listener)=>{notify=listener;return()=>{detached++;notify=undefined;};});
 assert.equal(pending.length,3);
 assert.equal(states.planning?.loading,true);assert.equal(Object.hasOwn(states.planning?.data??{},'summary'),false);
 notify!(path=>path.startsWith('planning/'));
 assert.equal(pending.length,4);assert.match(pending[3]!.path,/^planning\//);
 pending[3]!.resolve({summary:{completed:1}});await new Promise<void>(resolve=>setImmediate(resolve));
 pending[1]!.resolve({summary:{completed:0}});await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(states.planning?.data?.summary.completed,1);
 pending[0]!.reject(new Error('learning unavailable'));pending[2]!.resolve({summary:{upcoming:2}});
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.match(states.learning?.error??'',/learning unavailable/);assert.equal(states.scheduling?.data?.summary.upcoming,2);
 notify!(path=>path.startsWith('planning/'));
 const count=updates;loader.dispose();pending[4]!.resolve({summary:{completed:2}});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(updates,count);assert.equal(detached,1);
});

test('access invalidation clears existing overview results and stops fetching',async()=>{
 const {createOverviewLoader}=await import('../app/portal/overview-loader');
 let notify:((matches:(path:string)=>boolean,reason?:'access'|'dispose')=>void)|undefined;
 let calls=0;const states:import('../app/portal/overview-loader').OverviewLoad[]=[];
 const api:import('../lib/api').Api=async()=>{calls++;return {summary:{pending:0}};};
 const loader=createOverviewLoader(api,['learning'],'student',(_domain,state)=>states.push(state),String,(_api,listener)=>{notify=listener;return()=>{notify=undefined;};});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(states.at(-1)?.data?.summary.pending,0);
 notify!(()=>true,'access');assert.equal(states.at(-1)?.data,undefined);assert.match(states.at(-1)?.error??'',/Access changed/);
 await loader.refresh('learning');assert.equal(calls,1);loader.dispose();
});

test('background overview refresh keeps successful values and exposes retryable freshness failures',async()=>{
 const {createOverviewLoader}=await import('../app/portal/overview-loader');
 const pending:{resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]=[];
 const states:import('../app/portal/overview-loader').OverviewLoad[]=[];
 const api:import('../lib/api').Api=()=>new Promise((resolve,reject)=>pending.push({resolve,reject}));
 const loader=createOverviewLoader(api,['planning'],'s',(_domain,state)=>states.push(state),String,()=>()=>{});
 pending[0]!.resolve({summary:{completed:2}});await new Promise<void>(resolve=>setImmediate(resolve));
 const refresh=loader.refresh('planning');assert.equal(states.at(-1)?.loading,true);assert.equal(states.at(-1)?.data?.summary.completed,2);
 pending[1]!.reject(new Error('temporary failure'));await refresh;
 assert.equal(states.at(-1)?.loading,false);assert.equal(states.at(-1)?.data?.summary.completed,2);assert.match(states.at(-1)?.error??'',/temporary failure/);
 const retry=loader.refresh('planning');pending[2]!.resolve({summary:{completed:3}});await retry;
 assert.equal(states.at(-1)?.data?.summary.completed,3);assert.equal(states.at(-1)?.error,undefined);loader.dispose();
});
