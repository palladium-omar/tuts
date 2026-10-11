import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Deadline } from './schemas.js';
import type { TemplateCard, TemplateDefinition } from './templates.js';

// ISO 3166-1 choices are residence facts, not a claim of Études en France coverage.
export const countryCodes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
export const countrySchema = z.string().refine(v => countryCodes.includes(v), 'Choose a country from the list');
const requirement = z.enum(['required', 'not_required', 'unknown']);
export const applicantFactsSchema = z.object({
 residenceCountry: countrySchema.optional(), citizenshipCountries: z.array(countrySchema).min(1).max(10).refine(v => new Set(v).size === v.length, 'Citizenships must be unique').optional(),
 qualification: z.enum(['french_baccalaureate','european_baccalaureate','other']).optional(),
 entryLevel: z.enum(['first_year','later_undergraduate','masters','doctorate']).optional(),
 applicationRoute: z.enum(['etudes_en_france','parcoursup','dap','direct','mon_master']).optional(),
 campusFranceProcedure: z.enum(['hdap','dap','other','unknown']).optional(),
 aidSeeking: z.boolean().optional(), federalAidEligibility: z.enum(['eligible_citizen','eligible_noncitizen','ineligible','unknown']).optional(),
 cssProfileRequired: requirement.optional(), satRequired: requirement.optional(), satAccommodations: z.enum(['requested','not_requested']).optional(),
}).strict();
export type ApplicantFacts = z.infer<typeof applicantFactsSchema>;
export type ApplicantQuestion = {key: keyof ApplicantFacts; prompt:string; options:{value:string;label:string}[]};
export const ruleVersion = '2026-10-11.1';
const reviewedAt = '2026-10-11T15:00:00.000Z';
export const applicantSources = {
 general:'https://www.campusfrance.org/fr/candidature-enseignement-superieur-france', spaces:'https://www.campusfrance.org/fr/espaces',
 countries:'https://www.campusfrance.org/fr/candidature-procedure-etudes-en-france', european:'https://www.campusfrance.org/fr/candidature-etudiant-europeen',
 france:'https://www.campusfrance.org/fr/candidature-etudiant-non-europeen-resident-pays-UE',
 morocco:'https://www.maroc.campusfrance.org/calendrier-de-la-procedure-de-candidature-20262027',
 usa:'https://www.usa.campusfrance.org/applying-to-a-french-institution', bac:'https://www.usa.campusfrance.org/baccalaureat-holders-and-european-citizens',
 parcoursup:'https://www.parcoursup.gouv.fr/', monMaster:'https://www.monmaster.gouv.fr/', monMasterEligibility:'https://information.monmaster.gouv.fr/qui-peut-candidater-sur-mon-master/', eef:'https://etudesenfrance.diplomatie.gouv.fr/',
 fafsa:'https://studentaid.gov/understand-aid/eligibility', noncitizens:'https://studentaid.gov/understand-aid/eligibility/requirements/non-us-citizens', fafsaApply:'https://studentaid.gov/apply-for-aid/fafsa/filling-out',
 css:'https://cssprofile.collegeboard.org/', cssInstitutions:'https://profile.collegeboard.org/profile/ppi/participatingInstitutions.aspx',
 moroccoTime:'https://bdj.mmsp.gov.ma/Ar/Document/10664-D%C3%A9cret-n-2-26-530du-9-moharrem-1448-25-juin-2026.aspx', tz:'https://data.iana.org/time-zones/tzdb-2026c/NEWS',
};
export function applicantCountries() { return countryCodes.map(code => ({code, guidanceUrls: code==='MA'?[applicantSources.morocco,applicantSources.spaces]:code==='US'?[applicantSources.usa,applicantSources.bac]:code==='FR'?[applicantSources.france,applicantSources.general]:[applicantSources.spaces,applicantSources.general,applicantSources.countries]})); }
const european = new Set('AD AT BE BG CH CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LI LT LU LV MC MT NL NO PL PT RO SE SI SK'.split(' '));
// Ministry coverage list reviewed with local Campus France guidance. Selection
// still asks the applicant to confirm connected program / institution coverage.
const eefCountries=new Set('ZA DZ AO SA AR AM AZ BH BD BJ MM BO BR BF BI KH CM CA CL CN CO KM CG KR CI DJ AE EG EC US ET GA GE GH GN HT HK IN ID IR IQ IL JP JO KE KW LB MG MY ML MA MU MR MX NP NE NG PK PE QA CF CD DO GB RU SN SG TW TD TH TG TN TR UA VN'.split(' '));
const eeaResidence=new Set('AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LI LT LU LV MT NL NO PL PT RO SE SI SK'.split(' '));
const q = (key: keyof ApplicantFacts, prompt:string, choices:[string,string][]):ApplicantQuestion => ({key,prompt,options:choices.map(([value,label])=>({value,label}))});
function task(key:string,title:string,description:string,urls:string[],steps:string[],deadline:Deadline|null=null):TemplateCard {
 return {key,title,description,columnIndex:0,learningAssignmentId:null,deadline,references:urls.map(url=>({kind:'link',label:new URL(url).hostname,url})),checklist:steps.map(text=>{const h=createHash('sha256').update(`applicant-v1:${key}:${text}`).digest('hex');return {id:`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`,text,done:false};})};
}
export function campusTemplate(cycle:number):TemplateDefinition {
 return {key:`campus-france-${cycle}`,version:1,name:`Study in France ${cycle} — choose your residence and route`,cycle,country:'FR',applicantCountries:[],applicantCategory:'country_aware',program:'france_application',round:'applicant_route',applicability:'Confirm residence, citizenship, qualification, entry level and the procedure for your chosen institution. Country calendars are separate.',sourceUrls:[applicantSources.general,applicantSources.spaces],verifiedAt:null,columns:['To do','In progress','Review','Done'],cards:[]};
}
function routesFor(f:ApplicantFacts):[string,string][] {
 const isEuropean=f.citizenshipCountries?.some(c=>european.has(c));
 if(f.entryLevel==='doctorate') return [...(f.residenceCountry==='US'&&!isEuropean?[['etudes_en_france','Études en France — confirm an architecture DAP exception'] as [string,string]]:[]),['direct','Doctoral school / institution application']];
 if(f.entryLevel==='first_year'&&(isEuropean||f.qualification==='french_baccalaureate'||f.qualification==='european_baccalaureate')) return [['parcoursup','Parcoursup — confirm your course participates'],['direct','Specific institution procedure — confirm an exception']];
 const covered=eefCountries.has(f.residenceCountry??'');
 if(f.entryLevel==='first_year')return f.residenceCountry==='FR'?[['dap','DAP dossier vert — public university first year'],['parcoursup','Parcoursup — selective or DAP-exempt course'],['direct','Institution procedure / documented exemption']]:[...(covered?[['etudes_en_france','Études en France — confirm connected program'] as [string,string]]:[['dap','DAP through French embassy — public university first year'] as [string,string]]),['parcoursup','Parcoursup — course outside DAP'],['direct','Institution-specific application / documented exception']];
 if(f.entryLevel==='masters'&&(isEuropean||eeaResidence.has(f.residenceCountry??'')||!covered))return [['mon_master','Mon Master — confirm M1/program eligibility'],['direct','Institution-specific program / M2']];
 if(isEuropean)return [['direct','Apply directly to the institution']];
 return [...(covered?[['etudes_en_france','Études en France — confirm connected program'] as [string,string]]:[]),['direct','Apply directly — confirm institution procedure']];
}
function campusPreview(t:TemplateDefinition,f:ApplicantFacts) {
 const questions:ApplicantQuestion[]=[];
 if(!f.residenceCountry)questions.push(q('residenceCountry','Where do you currently live?',[]));
 if(!f.citizenshipCountries?.length)questions.push(q('citizenshipCountries','Which citizenships do you hold?',[]));
 if(!f.entryLevel)questions.push(q('entryLevel','Which study level are you applying for?',[['first_year','First year undergraduate'],['later_undergraduate','Later undergraduate year'],['masters','Master’s'],['doctorate','Doctorate']]));
 if(f.entryLevel==='first_year'&&!f.qualification)questions.push(q('qualification','Which qualification do you hold or expect?',[['french_baccalaureate','French baccalauréat'],['european_baccalaureate','European Baccalaureate (European Schools diploma)'],['other','Another qualification']]));
 const choices=questions.length?[]:routesFor(f);
 if(!questions.length&&(!f.applicationRoute||!choices.some(([v])=>v===f.applicationRoute)))questions.push(q('applicationRoute','Which procedure does your chosen course require?',choices));
 if(!questions.length&&f.residenceCountry==='US'&&f.applicationRoute==='etudes_en_france') {
  const procedureChoices:[string,string][]=[...(f.entryLevel==='later_undergraduate'||f.entryLevel==='masters'?[['hdap','HDAP — connected Licence 2/3 or Master’s; excludes architecture and art'] as [string,string]]:[]),['dap','DAP — public university first year or architecture at any level'],['other','Art or another institution-specific procedure'],['unknown','I need to confirm the course procedure']];
  if(!f.campusFranceProcedure||!procedureChoices.some(([v])=>v===f.campusFranceProcedure))questions.push(q('campusFranceProcedure','Which procedure does your actual USA Campus France course use?',procedureChoices));
 }
 const country=f.residenceCountry,route=f.applicationRoute,local=country==='MA'?applicantSources.morocco:country==='US'?applicantSources.usa:country==='FR'?applicantSources.france:applicantSources.spaces;
 const usaProcedureScope=country==='US'&&route==='etudes_en_france'?(f.campusFranceProcedure==='hdap'?' HDAP scope: connected Licence 2/3 or Master’s only; excludes architecture and art.':f.campusFranceProcedure==='dap'?' DAP scope: public-university first year or architecture at every level.':' Course procedure and its separate calendar require confirmation; art is not assigned the HDAP deadline.'):'';
 const scope=`${t.cycle} entry; residence ${country??'to confirm'}, route ${route??'to confirm'}, level ${f.entryLevel??'to confirm'}${country==='US'&&route==='etudes_en_france'?`, course procedure ${f.campusFranceProcedure??'to confirm'}`:''}. Confirm course coverage, exemptions and any parallel procedure.${usaProcedureScope}`;
 const routeUrl=route==='parcoursup'?applicantSources.parcoursup:route==='mon_master'?applicantSources.monMaster:route==='etudes_en_france'?applicantSources.eef:route==='dap'?applicantSources.france:applicantSources.general;
 let dueAt:string|null=null,timeZone='Etc/UTC',dateSource:string[]=[local];
 // Calendar records apply only to the verified cycle, country, level and route.
 if(t.cycle===2027&&route==='etudes_en_france'&&country==='MA'&&f.entryLevel!=='doctorate') {dueAt='2026-11-15T23:59:00Z';timeZone='Africa/Casablanca';dateSource=[local,applicantSources.moroccoTime,applicantSources.tz];}
 if(t.cycle===2027&&route==='etudes_en_france'&&country==='US'&&f.campusFranceProcedure==='hdap'&&(f.entryLevel==='later_undergraduate'||f.entryLevel==='masters')) {dueAt='2027-01-15T23:00:00Z';timeZone='America/New_York';}
 const d:Deadline={kind:'official',dueAt,timeZone,sourceUrls:dateSource,cycle:t.cycle,round:t.round,applicability:scope,status:dueAt?'verified':'requires_confirmation',verifiedAt:dueAt?reviewedAt:null};
 // US DAP (including architecture at all levels) and France first-year DAP
 // pages specify a day without a cutoff time. Keep it
 // in readable scope, not a fabricated instant or midnight deadline.
 const day=t.cycle===2027&&((country==='US'&&route==='etudes_en_france'&&f.campusFranceProcedure==='dap')||(country==='FR'&&route==='dap'&&f.entryLevel==='first_year'))?' The official DAP closing day is December 15, 2026; confirm the cutoff time and applicable form.':'';
 const definition={...structuredClone(t),applicability:scope,sourceUrls:[local,routeUrl,applicantSources.general,...(route==='mon_master'?[applicantSources.monMasterEligibility]:[])],cards:[
 task('procedure','Confirm your French application route',scope,[local,applicantSources.general,applicantSources.european,applicantSources.bac],['Check your residence, citizenship, qualification and entry level against official guidance.','Confirm that the chosen course uses this procedure, including exemptions and parallel applications.']),
 task('language','Check language requirements and exemptions','The program and your documented qualification determine the accepted certification.',[local,applicantSources.general],['Check accepted language tests and any documented exemption with the program.','Arrange an accepted test if needed; confirm its booking and result deadlines.']),
 task('documents','Prepare the required application documents','Use the selected procedure’s current checklist.',[routeUrl,local],['Open the official procedure and confirm the entry year.','Gather academic records, identification and requested supporting documents.','Complete program choices and motivations where required.']),
 task('submit','Confirm the deadline and submit through your selected route',scope+day,[local,routeUrl],['Confirm the applicable local closing date, cutoff time and time zone.','Review the selected procedure and any separate institution application.','Submit and retain confirmation; follow official payment, interview and response instructions where required.'],d),
 ]};
 if(country==='US'&&route==='etudes_en_france'&&(!f.campusFranceProcedure||['unknown','other'].includes(f.campusFranceProcedure)))definition.cards.push(task('procedure-review','Confirm the actual course procedure and calendar','The HDAP deadline is not assigned until a connected HDAP course is confirmed. Architecture uses DAP at all levels; art and institution-specific courses may follow another process.',[applicantSources.usa,applicantSources.general],['Confirm whether the actual course is HDAP, DAP, art or institution-specific with Campus France USA and the institution.','Record the appropriate procedure and its own deadline; do not reuse the HDAP closing time.']));
 return {definition,questions};
}
function commonPreview(t:TemplateDefinition,f:ApplicantFacts) {
 const questions:ApplicantQuestion[]=[];
 if(f.aidSeeking===undefined)questions.push(q('aidSeeking','Would you like to apply for financial aid?',[['true','Yes'],['false','No']]));
 if(f.aidSeeking&&f.federalAidEligibility===undefined)questions.push(q('federalAidEligibility','What is your confirmed federal aid eligibility?',[['eligible_citizen','Eligible US citizen or national; other requirements confirmed'],['eligible_noncitizen','Eligible noncitizen; other requirements confirmed'],['ineligible','Not eligible for federal aid'],['unknown','I need to check']]));
 if(f.aidSeeking&&f.cssProfileRequired===undefined)questions.push(q('cssProfileRequired','Do your selected colleges require CSS Profile?',[['required','Yes, at least one participating college requires it'],['not_required','No'],['unknown','I need to check college requirements']]));
 if(f.satRequired===undefined)questions.push(q('satRequired','Will you submit SAT scores for your chosen colleges?',[['required','Yes — required or chosen'],['not_required','No'],['unknown','I need to check their testing policies']]));
 const definition=structuredClone(t);
 definition.cards=definition.cards.filter(c=>!(c.key.startsWith('financial-aid-')&&f.aidSeeking!==true)&&!(c.key.startsWith('sat-')&&f.satRequired!=='required')&&c.key!=='fafsa-eligible-optional'&&c.key!=='sat-accommodations-optional');
 // General aid milestones describe required college forms; CSS links and steps
 // appear only after a participating college requirement is confirmed.
 for(const c of definition.cards.filter(c=>c.key.startsWith('financial-aid-'))) {c.references=[{kind:'link',label:'College aid requirements guide',url:'https://www.commonapp.org/apply/first-year-students/'}];c.checklist=task(c.key,c.title,c.description,[],['Confirm each college’s aid forms, applicant eligibility and priority deadline.','Complete only the forms required by the selected college; retain its confirmation.']).checklist;}
 if(f.aidSeeking&&(f.federalAidEligibility==='eligible_citizen'||f.federalAidEligibility==='eligible_noncitizen'))definition.cards.push(task('fafsa','Complete FAFSA — confirmed eligible applicant','Citizens and eligible noncitizens may qualify when other federal requirements are met.',[applicantSources.fafsa,applicantSources.noncitizens,applicantSources.fafsaApply],['Confirm the correct academic year and college/state filing deadlines.','Prepare contributor accounts, requested records, consent and signatures.','Submit and review the FAFSA Submission Summary and college requests.']));
 if(f.aidSeeking&&(f.federalAidEligibility==='unknown'||f.cssProfileRequired==='unknown'))definition.cards.push(task('aid-eligibility-review','Confirm financial aid eligibility and college requirements','Unresolved eligibility does not authorize a FAFSA or CSS filing task.',[applicantSources.fafsa,applicantSources.noncitizens,applicantSources.cssInstitutions],['Review federal eligibility with official guidance and the college aid office.','Confirm each college’s required institutional aid forms and deadlines.']));
 if(f.aidSeeking&&f.cssProfileRequired==='required')definition.cards.push(task('css-profile','Complete CSS Profile — required participating colleges','CSS Profile can apply to US and international applicants. Check each participating college’s applicant requirements.',[applicantSources.css,applicantSources.cssInstitutions],['Confirm that your college requires CSS Profile for your applicant category and academic year.','Gather the requested family financial records and check noncustodial parent requirements.','Submit to required participating colleges by their confirmed deadlines and follow document requests.']));
 if(f.satRequired==='unknown')definition.cards.push(task('testing-review','Confirm college testing policies','Check score requirements before arranging SAT preparation.', ['https://www.commonapp.org/apply/first-year-students/'],['Check each college’s testing policy, last accepted test and score-reporting rules.']));
 if(f.satRequired==='required'&&f.satAccommodations==='requested') {const c=t.cards.find(c=>c.key==='sat-accommodations-optional');if(c)definition.cards.push({...structuredClone(c),title:'Request SAT accommodations — student selected'});}
 return {definition,questions};
}
export function usesApplicantRules(t:TemplateDefinition) { return t.applicantCategory==='country_aware'||(t.key.startsWith('common-app')&&t.version>=(t.cycle===2027?4:3)); }
export function personalizedTemplate(t:TemplateDefinition,f:ApplicantFacts={}) {
 const {definition,questions}=t.applicantCategory==='country_aware'?campusPreview(t,f):usesApplicantRules(t)?commonPreview(t,f):{definition:structuredClone(t),questions:[]};
 return {definition,questions,ready:questions.length===0,applicantFacts:f,ruleVersion:usesApplicantRules(t)?ruleVersion:null};
}
