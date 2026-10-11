import assert from 'node:assert/strict';
import test from 'node:test';
import { applicantCountries, applicantFactsSchema, campusTemplate, personalizedTemplate, ruleVersion, type ApplicantFacts } from '../src/applicant-rules.js';
import { applicantTemplatesForCycle, templatesForCycle, builtInTemplates } from '../src/templates.js';
import { deadlineSchema, checklistSchema, referenceSchema, instantiateSchema } from '../src/schemas.js';
const campus = campusTemplate(2027);
const base:ApplicantFacts={residenceCountry:'MA',citizenshipCountries:['MA'],entryLevel:'first_year',qualification:'other',applicationRoute:'etudes_en_france'};
const submit=(f:ApplicantFacts,cycle=2027)=>personalizedTemplate(campusTemplate(cycle),f).definition.cards.find(c=>c.key==='submit')!;
test('Campus France requires confirmed residence, citizenship, study level and qualification; never defaults to Morocco',()=>{
 const unknown=personalizedTemplate(campus,{});assert.equal(unknown.ready,false);assert.equal(unknown.questions[0]!.key,'residenceCountry');assert.equal(unknown.applicantFacts.residenceCountry,undefined);assert.equal(unknown.definition.cards.find(c=>c.key==='submit')!.deadline!.dueAt,null);
 const ready=personalizedTemplate(campus,base);assert.equal(ready.ready,true);assert.equal(ready.ruleVersion,ruleVersion);assert.equal(submit(base).deadline!.dueAt,'2026-11-15T23:59:00Z');
});
test('country and cycle calendars never reuse a Morocco deadline or local link',()=>{
 for(const code of ['FR','US','DE','BR','AU','JP','DZ']){
  const f={...base,residenceCountry:code,applicationRoute:code==='FR'?'dap' as const:'etudes_en_france' as const};
  const card=submit(f);assert.equal(card.deadline!.dueAt,null);assert.equal(card.deadline!.status,'requires_confirmation');assert.ok(!JSON.stringify(personalizedTemplate(campus,f).definition).includes('maroc.campusfrance'));
 }
 assert.equal(submit({...base,residenceCountry:'US',entryLevel:'masters',campusFranceProcedure:'hdap'}).deadline!.dueAt,'2027-01-15T23:00:00Z');
 assert.match(submit({...base,residenceCountry:'US',campusFranceProcedure:'dap'}).description,/December 15, 2026/);
 assert.match(submit({...base,residenceCountry:'FR',applicationRoute:'dap'}).description,/December 15, 2026/);
 assert.equal(submit(base,2028).deadline!.dueAt,null);
});
test('French, EU/EEA/Swiss citizenship and French/European bac route through appropriate guidance',()=>{
 for(const facts of [{citizenshipCountries:['FR']},{citizenshipCountries:['MA','DE']},{citizenshipCountries:['NO']},{qualification:'french_baccalaureate' as const},{qualification:'european_baccalaureate' as const}]){
  const bad=personalizedTemplate(campus,{...base,...facts});assert.equal(bad.ready,false);assert.equal(bad.questions[0]!.key,'applicationRoute');assert.ok(!bad.questions[0]!.options.some(o=>o.value==='etudes_en_france'));
  assert.equal(personalizedTemplate(campus,{...base,...facts,applicationRoute:'parcoursup'}).ready,true);
 }
 assert.equal(personalizedTemplate(campus,{...base,entryLevel:'doctorate',applicationRoute:'etudes_en_france'}).ready,false);
 assert.equal(personalizedTemplate(campus,{...base,entryLevel:'doctorate',applicationRoute:'direct'}).ready,true);
});
test('FAFSA includes confirmed eligible noncitizens; CSS depends on college requirements for every nationality',()=>{
 const t=applicantTemplatesForCycle(2027).find(t=>t.key.startsWith('common-app'))!;
 for(const federalAidEligibility of ['eligible_citizen','eligible_noncitizen'] as const){
  const p=personalizedTemplate(t,{aidSeeking:true,federalAidEligibility,cssProfileRequired:'required',satRequired:'not_required'});assert.equal(p.ready,true);assert.ok(p.definition.cards.some(c=>c.key==='fafsa'));assert.ok(p.definition.cards.some(c=>c.key==='css-profile'));assert.ok(!p.definition.cards.some(c=>c.key.startsWith('sat-')));
 }
 const unknown=personalizedTemplate(t,{aidSeeking:true,federalAidEligibility:'unknown',cssProfileRequired:'unknown',satRequired:'unknown'});assert.equal(unknown.ready,true);assert.ok(unknown.definition.cards.some(c=>c.key==='aid-eligibility-review'));assert.ok(!unknown.definition.cards.some(c=>c.key==='fafsa'||c.key==='css-profile'));assert.ok(unknown.definition.cards.some(c=>c.key==='testing-review'));
 const ineligible=personalizedTemplate(t,{aidSeeking:true,federalAidEligibility:'ineligible',cssProfileRequired:'required',satRequired:'not_required'});assert.ok(!ineligible.definition.cards.some(c=>c.key==='fafsa'));assert.ok(ineligible.definition.cards.some(c=>c.key==='css-profile'));
 assert.equal(personalizedTemplate(t,{}).ready,false);
 const noAid=personalizedTemplate(t,{aidSeeking:false,satRequired:'not_required'});assert.equal(noAid.ready,true);assert.ok(!noAid.definition.cards.some(c=>/financial-aid|fafsa|css-profile/.test(c.key)));
});
test('new immutable releases preserve prior definitions and personalized tasks pass existing card validation',()=>{
 const before=structuredClone(builtInTemplates.filter(t=>!t.key.match(/^campus-france-\d/) && t.version<4));
 const old=templatesForCycle(2027).find(t=>t.key==='common-app-2027')!;assert.equal(old.version,3);assert.deepEqual(personalizedTemplate(old,{}).definition,old);
 for(const facts of [base,{...base,residenceCountry:'US',entryLevel:'masters' as const}])for(const card of personalizedTemplate(campus,facts).definition.cards){if(card.deadline)deadlineSchema.parse(card.deadline);checklistSchema.parse(card.checklist);card.references.forEach(r=>referenceSchema.parse(r));}
 assert.deepEqual(builtInTemplates.filter(t=>!t.key.match(/^campus-france-\d/) && t.version<4),before);
 assert.equal(builtInTemplates.find(t=>t.key==='common-app-2027'&&t.version===4)!.cards.length,old.cards.length);
});
test('all ISO choices use official guidance and facts reject extra private metadata',()=>{
 const countries=applicantCountries();assert.equal(countries.length,249);assert.ok(countries.every(c=>c.guidanceUrls.length&&c.guidanceUrls.every(u=>new URL(u).hostname.endsWith('campusfrance.org'))));
 assert.equal(applicantFactsSchema.safeParse({residenceCountry:'ZZ'}).success,false);assert.equal(applicantFactsSchema.safeParse({...base,diagnosis:'private'}).success,false);
 assert.throws(()=>instantiateSchema.parse({studentId:'22222222-2222-4222-8222-222222222222',version:1,idempotencyKey:'synthetic-123',applicabilityConfirmed:true,applicability:{cycle:2027,country:'FR',applicantCategory:'country_aware',program:'france_application',round:'applicant_route',applicantFacts:{privateNotes:'secret'}}}));
});

test('Études en France coverage and Mon Master eligibility use residence and citizenship separately',()=>{
 for(const residenceCountry of ['AU','DE','NZ']){
  assert.equal(personalizedTemplate(campus,{...base,residenceCountry}).ready,false);
  assert.equal(personalizedTemplate(campus,{...base,residenceCountry,entryLevel:'masters',applicationRoute:'mon_master'}).ready,true);
 }
 for(const residenceCountry of ['MA','US']) assert.equal(personalizedTemplate(campus,{...base,residenceCountry,entryLevel:'masters',applicationRoute:'mon_master'}).ready,false);
 assert.equal(personalizedTemplate(campus,{...base,residenceCountry:'US',citizenshipCountries:['FR'],entryLevel:'masters',applicationRoute:'mon_master'}).ready,true);
});

test('USA course procedure confirmation isolates HDAP, all-level architecture DAP and art/unresolved routes',()=>{
 const us:ApplicantFacts={...base,residenceCountry:'US',entryLevel:'masters'};
 const missing=personalizedTemplate(campus,us);assert.equal(missing.ready,false);assert.equal(missing.questions[0]!.key,'campusFranceProcedure');assert.match(missing.questions[0]!.options.find(o=>o.value==='hdap')!.label,/excludes architecture and art/);assert.match(missing.questions[0]!.options.find(o=>o.value==='dap')!.label,/architecture at any level/);
 for(const entryLevel of ['later_undergraduate','masters'] as const){
  const hdap=personalizedTemplate(campus,{...us,entryLevel,campusFranceProcedure:'hdap'});assert.equal(hdap.ready,true);const deadline=hdap.definition.cards.find(c=>c.key==='submit')!.deadline!;assert.equal(deadline.dueAt,'2027-01-15T23:00:00Z');assert.equal(deadline.timeZone,'America/New_York');assert.equal(deadline.status,'verified');assert.match(deadline.applicability,/course procedure hdap/);
 }
 for(const entryLevel of ['first_year','later_undergraduate','masters','doctorate'] as const){
  const dap=personalizedTemplate(campus,{...us,entryLevel,campusFranceProcedure:'dap'});assert.equal(dap.ready,true);const card=dap.definition.cards.find(c=>c.key==='submit')!;assert.match(card.description,/December 15, 2026/);assert.equal(card.deadline!.dueAt,null);assert.equal(card.deadline!.verifiedAt,null);assert.equal(card.deadline!.status,'requires_confirmation');assert.ok(!JSON.stringify(dap.definition).includes('2027-01-15'));
 }
 for(const campusFranceProcedure of ['other','unknown'] as const){
  const unresolved=personalizedTemplate(campus,{...us,campusFranceProcedure});assert.equal(unresolved.ready,true);assert.ok(unresolved.definition.cards.some(c=>c.key==='procedure-review'));const card=unresolved.definition.cards.find(c=>c.key==='submit')!;assert.equal(card.deadline!.dueAt,null);assert.doesNotMatch(card.description,/December 15, 2026/);assert.equal(card.deadline!.status,'requires_confirmation');
 }
 const invalid=personalizedTemplate(campus,{...us,entryLevel:'first_year',campusFranceProcedure:'hdap'});assert.equal(invalid.ready,false);assert.equal(invalid.questions[0]!.key,'campusFranceProcedure');assert.ok(!invalid.questions[0]!.options.some(o=>o.value==='hdap'));assert.equal(invalid.definition.cards.find(c=>c.key==='submit')!.deadline!.dueAt,null);
 assert.equal(submit({...us,campusFranceProcedure:'hdap'},2028).deadline!.dueAt,null);
 assert.equal(personalizedTemplate(campus,{...us,entryLevel:'doctorate',citizenshipCountries:['FR'],campusFranceProcedure:'dap'}).ready,false);
 assert.equal(personalizedTemplate(campus,{...us,entryLevel:'doctorate',citizenshipCountries:['FR'],applicationRoute:'direct'}).ready,true);
 for(const residenceCountry of ['MA','DZ'])assert.equal(personalizedTemplate(campus,{...base,residenceCountry}).questions.some(q=>q.key==='campusFranceProcedure'),false);
 assert.equal(applicantFactsSchema.safeParse({campusFranceProcedure:'unverified-hdap'}).success,false);
});
