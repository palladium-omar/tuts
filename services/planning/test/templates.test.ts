import assert from 'node:assert/strict';
import test from 'node:test';
import {builtInTemplates,cycleForSystemKey,legacyTemplates,templatesForCycle} from '../src/templates.js';
import {deadlineSchema,enteredDeadline,templateQuerySchema} from '../src/schemas.js';

test('latest 2027 release has dated cards while preserving the original release and card identities',()=>{
 const originals=structuredClone(legacyTemplates);
 for(const t of templatesForCycle(2027)){
  assert.equal(t.version,2);
  const old=originals.find(item=>item.key===t.key)!;
  assert.ok(old.cards.every(card=>t.cards.some(next=>next.key===card.key)));
  for(const card of t.cards){assert.ok(card.deadline?.dueAt,`${t.key}/${card.key} must be dated`);deadlineSchema.parse(card.deadline);}
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
   for(const c of t.cards){
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
  'campus-france-maroc-2027':'2026-11-15T22:59:00Z',
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
