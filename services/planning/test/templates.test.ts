import assert from 'node:assert/strict';
import test from 'node:test';
import {builtInTemplates,cycleForSystemKey,legacyTemplates,milestoneTemplatesForCycle,actionableTemplatesForCycle,templatesForCycle} from '../src/templates.js';
import {deadlineSchema,enteredDeadline,templateQuerySchema} from '../src/schemas.js';

test('latest 2027 release has dated cards while preserving the original release and card identities',()=>{
 const originals=structuredClone(legacyTemplates);
 for(const t of templatesForCycle(2027)){
  assert.equal(t.version,t.key==='campus-france-maroc-2027'?4:3);
  const old=originals.find(item=>item.key===t.key)!;
  assert.ok(old.cards.every(card=>t.cards.some(next=>next.key===card.key)));
  for(const card of t.cards.filter(card=>!card.key.endsWith('-optional'))){assert.ok(card.deadline?.dueAt,`${t.key}/${card.key} must be dated`);deadlineSchema.parse(card.deadline);}
  assert.ok(builtInTemplates.some(item=>item.key===t.key&&item.version===1));
 }
 assert.deepEqual(legacyTemplates,originals);
});
test('Common App uses typical ED/EA and RD targets with separate aid and testing preparation',()=>{
 const t=templatesForCycle(2027).find(t=>t.key==='common-app-2027')!;
 for(const [key,date,round] of [['submit','2026-11-01','ed_ea'],['rd-submit','2027-01-01','regular_decision']]){
  const card=t.cards.find(c=>c.key===key)!;
  assert.equal(card.deadline?.dueAt?.slice(0,10),date);assert.equal(card.deadline?.round,round);
  assert.equal(card.deadline?.kind,'personal');assert.equal(card.deadline?.status,'requires_confirmation');assert.equal(card.deadline?.verifiedAt,null);
  assert.match(card.description,/not a universal admissions deadline/);
 }
 assert.ok(t.cards.some(card=>card.key==='financial-aid-early'));
 assert.ok(t.cards.some(card=>card.key==='financial-aid-rd'));
 const early=t.cards.find(card=>card.key==='sat-early-registration')!.deadline!,rd=t.cards.find(card=>card.key==='sat-rd-registration')!.deadline!;
 assert.equal(early.dueAt,'2026-09-19T03:59:00Z');assert.equal(rd.dueAt,'2026-11-21T04:59:00Z');
 for(const d of [early,rd]){assert.equal(d.status,'verified');assert.equal(d.timeZone,'America/New_York');assert.ok(d.sourceUrls.every(url=>new URL(url).hostname==='satsuite.collegeboard.org'));}
 assert.match(t.cards.find(card=>card.key==='sat-early-test')!.description,/October 3, 2026; scores October 16/);
 assert.match(t.cards.find(card=>card.key==='sat-rd-test')!.description,/December 5, 2026; scores December 18/);
});
test('future cycles have useful dated personal targets and no extrapolated official deadlines',()=>{
 for(const cycle of [2028,2029,2030,2031,2035,2200]){
  const templates=templatesForCycle(cycle);assert.equal(templates.length,6);
  for(const t of templates){
   assert.equal(t.cycle,cycle);assert.equal(t.verifiedAt,null);assert.equal(cycleForSystemKey(t.key),cycle);
   assert.ok(!t.name.includes('(closed)'));assert.ok(!t.name.includes('2026'));assert.ok(t.name.includes(String(cycle)));
   for(const c of t.cards.filter(card=>!card.key.endsWith('-optional'))){
    const d=deadlineSchema.parse(c.deadline);assert.equal(d.cycle,cycle);assert.ok(d.dueAt);
    assert.equal(d.kind,'personal');assert.equal(d.status,'requires_confirmation');assert.equal(d.verifiedAt,null);
    assert.ok([String(cycle-1),String(cycle)].includes(d.dueAt!.slice(0,4)));
   }
  }
  assert.equal(templates.find(t=>t.key===`campus-france-maroc-${cycle}`)!.round,`${cycle-1}_${String(cycle).slice(-2)}_procedure`);
 }
 assert.equal(templatesForCycle(2028).find(t=>t.key==='bocconi-2028-winter-international')!.name,'Bocconi 2028–29 — international Winter');
});
test('published official 2027 deadline scope remains distinct from personal reminders',()=>{
 const templates=templatesForCycle(2027),expected:Record<string,string>={
  'ucas-2027-standard':'2027-01-13T18:00:00Z','ucas-2027-early':'2026-10-15T17:00:00Z',
  'bocconi-2027-winter-international':'2027-01-26T14:00:00Z','bocconi-2027-early-international':'2026-09-29T13:00:00Z',
  'campus-france-maroc-2027':'2026-11-15T23:59:00Z',
 };
 for(const [key,date] of Object.entries(expected)){
  const d=templates.find(t=>t.key===key)!.cards.find(card=>card.key==='submit')!.deadline!;
  assert.equal(d.dueAt,date);assert.equal(d.kind,'official');assert.equal(d.status,'verified');assert.ok(d.sourceUrls.length>0);
 }
 const personal=enteredDeadline({kind:'personal',dueAt:'2030-01-01T12:00:00Z',timeZone:'Etc/UTC',sourceUrls:[],cycle:2030,round:'regular_decision',applicability:''});
 assert.equal(personal!.status,'user_set');assert.equal(personal!.verifiedAt,null);
 assert.throws(()=>templatesForCycle(2026));assert.throws(()=>templatesForCycle(2201));assert.throws(()=>templateQuerySchema.parse({cycle:2026}));
 assert.equal(cycleForSystemKey('custom-2032-plan'),undefined);
});

 test('actionable release retains earlier releases and validates every task resource',async()=>{
 const {referenceSchema,checklistSchema}=await import('../src/schemas.js');
 const before=structuredClone(milestoneTemplatesForCycle(2027));
 for(const cycle of [2027,2028,2035]){
  for(const t of templatesForCycle(cycle)){
   assert.equal(t.version,t.key==='campus-france-maroc-2027'?4:cycle===2027?3:2);
   for(const c of t.cards){assert.ok(c.references.length>0,`${t.key}/${c.key}`);assert.ok(c.checklist.length>0);c.references.forEach(r=>referenceSchema.parse(r));checklistSchema.parse(c.checklist);}
  }
 }
 assert.deepEqual(milestoneTemplatesForCycle(2027),before);
 for(const t of before)assert.deepEqual(builtInTemplates.find(v=>v.key===t.key&&v.version===2),t);
 const common=templatesForCycle(2027).find(t=>t.key==='common-app-2027')!;
 for(const key of ['sat-accommodations-optional','fafsa-eligible-optional'])assert.equal(common.cards.find(c=>c.key===key)!.deadline,null);
 assert.match(common.cards.find(c=>c.key==='sat-accommodations-optional')!.description,/No diagnosis/);
 assert.match(common.cards.find(c=>c.key==='fafsa-eligible-optional')!.description,/confirms.*eligibility/);
 assert.deepEqual(templatesForCycle(2035),templatesForCycle(2035));
 });

test('Campus France v4 preserves 23:59 Morocco source wall time and earlier immutable conversions',()=>{
 const key='campus-france-maroc-2027',latest=templatesForCycle(2027).find(t=>t.key===key)!;
 const d=latest.cards.find(c=>c.key==='submit')!.deadline!;
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:d.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(d.dueAt!));
 const part=(type:string)=>parts.find(p=>p.type===type)!.value;
 assert.equal(`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`,'2026-11-15 23:59','Runtime tzdb must include Morocco September 2026 permanent UTC change');
 assert.equal(latest.version,4);assert.ok(d.sourceUrls.some(url=>url.includes('tzdb-2026c')));assert.ok(d.sourceUrls.some(url=>url.includes('2-26-530')));
 for(const version of [1,2,3])assert.equal(builtInTemplates.find(t=>t.key===key&&t.version===version)!.cards.find(c=>c.key==='submit')!.deadline!.dueAt,'2026-11-15T22:59:00Z');
 assert.deepEqual(builtInTemplates.find(t=>t.key===key&&t.version===3),actionableTemplatesForCycle(2027).find(t=>t.key===key));
 assert.equal(templatesForCycle(2028).find(t=>t.key==='campus-france-maroc-2028')!.version,2);
});
