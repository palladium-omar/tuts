import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {registerHooks} from 'node:module';
// The Node render harness ignores stylesheet imports; production bundling keeps them.
registerHooks({load(url,context,nextLoad){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:nextLoad(url,context);}});
const {ApplicantDetailsReview, TemplateLoadRetry, changeApplicantFact}=await import('../features/student-board-template');

test('saved no-aid facts remain reviewable and can be changed for a new application plan',()=>{
 const saved={aidSeeking:false,satRequired:'not_required' as const};
 const html=renderToStaticMarkup(createElement(ApplicantDetailsReview,{definition:{key:'common-app-2027'},facts:saved,busy:false,onChange:()=>{},onDone:()=>{}}));
 assert.match(html,/Change Apply for financial aid/);assert.match(html,/>No</);assert.match(html,/Return to my plan/);
 const questionFacts=changeApplicantFact(saved,'aidSeeking',undefined);assert.equal(questionFacts.aidSeeking,undefined);assert.equal(saved.aidSeeking,false);
 const selectedFacts=changeApplicantFact(questionFacts,'aidSeeking',true);assert.equal(selectedFacts.aidSeeking,true);assert.equal(selectedFacts.satRequired,'not_required');
});
test('changing residence, citizenship, qualification or study level clears a previously confirmed route',()=>{
 const saved={residenceCountry:'MA',citizenshipCountries:['FR'],qualification:'french_baccalaureate' as const,entryLevel:'first_year' as const,applicationRoute:'parcoursup' as const};
 const html=renderToStaticMarkup(createElement(ApplicantDetailsReview,{definition:{applicantCategory:'country_aware'},facts:saved,busy:false,onChange:()=>{},onDone:()=>{}}));
 assert.match(html,/Change Country of residence/);assert.match(html,/Morocco/);assert.match(html,/Change Citizenships/);assert.match(html,/Change Application procedure/);
 for(const key of ['residenceCountry','citizenshipCountries','qualification','entryLevel'] as const){const next=changeApplicantFact(saved,key,undefined);assert.equal(next[key],undefined);assert.equal(next.applicationRoute,undefined);assert.equal(saved.applicationRoute,'parcoursup');}
});
test('an explicit plan-load retry is available and pending work disables repeat actions',()=>{
 const retry=renderToStaticMarkup(createElement(TemplateLoadRetry,{busy:false,onRetry:()=>{}}));assert.match(retry,/Retry loading plans/);assert.doesNotMatch(retry,/disabled/);
 const pending=renderToStaticMarkup(createElement(TemplateLoadRetry,{busy:true,onRetry:()=>{}}));assert.match(pending,/disabled/);
 const review=renderToStaticMarkup(createElement(ApplicantDetailsReview,{definition:{key:'common-app-2027'},facts:{aidSeeking:true,federalAidEligibility:'unknown',cssProfileRequired:'unknown',satRequired:'unknown'},busy:true,onChange:()=>{},onDone:()=>{}}));assert.match(review,/Needs confirmation/);assert.match(review,/disabled/);
});

test('USA course procedure remains reviewable and resets when its route or applicant scope changes',()=>{
 const saved={residenceCountry:'US',citizenshipCountries:['MA'],entryLevel:'masters' as const,applicationRoute:'etudes_en_france' as const,campusFranceProcedure:'hdap' as const};
 const html=renderToStaticMarkup(createElement(ApplicantDetailsReview,{definition:{applicantCategory:'country_aware'},facts:saved,busy:false,onChange:()=>{},onDone:()=>{}}));assert.match(html,/Change USA course procedure/);assert.match(html,/excludes architecture and art/);
 for(const key of ['residenceCountry','citizenshipCountries','qualification','entryLevel','applicationRoute'] as const){const next=changeApplicantFact(saved,key,undefined);assert.equal(next.campusFranceProcedure,undefined);assert.equal(saved.campusFranceProcedure,'hdap');}
 const changed=changeApplicantFact(saved,'campusFranceProcedure','dap');assert.equal(changed.campusFranceProcedure,'dap');assert.equal(changed.applicationRoute,'etudes_en_france');
 const other=renderToStaticMarkup(createElement(ApplicantDetailsReview,{definition:{applicantCategory:'country_aware'},facts:{...saved,campusFranceProcedure:'other'},busy:false,onChange:()=>{},onDone:()=>{}}));assert.match(other,/Art or another institution-specific procedure/);
 const nonUS=renderToStaticMarkup(createElement(ApplicantDetailsReview,{definition:{applicantCategory:'country_aware'},facts:{...saved,residenceCountry:'MA'},busy:false,onChange:()=>{},onDone:()=>{}}));assert.doesNotMatch(nonUS,/USA course procedure/);
});
