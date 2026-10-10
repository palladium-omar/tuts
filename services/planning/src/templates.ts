import type {Deadline} from './schemas.js';
export interface TemplateCard {
 key:string;title:string;description:string;columnIndex:number;checklist:{id:string;text:string;done:boolean}[];
 references:Record<string,unknown>[];deadline:Deadline|null;learningAssignmentId:string|null;
}
export interface TemplateDefinition {
 key:string;version:number;name:string;cycle:number;country:string;applicantCountries:string[];applicantCategory:string;
 program:string;round:string;applicability:string;sourceUrls:string[];verifiedAt:string|null;columns:string[];cards:TemplateCard[];
}
// Sources reviewed on 2026-10-10. A new source review publishes a new immutable
// version; it never overwrites a date already edited on a student's board.
const verifiedAt='2026-10-10T11:14:30.000Z';
const ucas='https://www.ucas.com/applying/applying-to-university/dates-and-deadlines-for-uni-applications';
const ucasStandard='https://www.ucas.com/events/2027-entry-deadline-for-all-undergraduate-courses-except-those-with-a-15-october-deadline-475546';
const common='https://www.commonapp.org/blog/common-app-opens-application-launch-2026-27-season/';
const bocconi='https://www.unibocconi.it/en/applying-bocconi/bachelor-and-law-programs/application-and-admissions/admissions';
const campus='https://www.maroc.campusfrance.org/calendrier-de-la-procedure-de-candidature-20262027';
function deadline(dueAt:string|null,timeZone:string,sourceUrls:string[],round:string,applicability:string):Deadline {
 return {kind:'official',dueAt,timeZone,sourceUrls,cycle:2027,round,applicability,status:dueAt?'verified':'requires_confirmation',verifiedAt:dueAt?verifiedAt:null};
}
function card(key:string,title:string,description:string,deadline:Deadline|null=null):TemplateCard {
 return {key,title,description,columnIndex:0,checklist:[],references:[],deadline,learningAssignmentId:null};
}
function template(key:string,name:string,country:string,applicantCategory:string,program:string,round:string,applicability:string,sourceUrls:string[],cards:TemplateCard[],applicantCountries:string[]=[]):TemplateDefinition {
 return {key,version:1,name,cycle:2027,country,applicantCountries,applicantCategory,program,round,applicability,sourceUrls,verifiedAt,columns:['To do','In progress','Review','Done'],cards};
}
const standardScope='2027 entry UCAS undergraduate courses with the standard equal-consideration deadline. Check the individual course listing; exclude the October deadline courses and special start dates.';
const earlyScope='2027 entry Oxford/Cambridge and most medicine, dentistry, veterinary medicine/science courses. Confirm the chosen course listing; not every course in these subjects uses this deadline.';
const internationalScope='Bocconi 2027–28 international applicants for standard Bachelor/Law selection. Excludes Italian-applicant procedures, World Bachelor in Business and HEC-Bocconi dedicated admissions. Verify category and diploma requirements.';
const campusScope='Applicants using Campus France Morocco for 2027 entry: Études en France connected programs and listed DAP procedures (L1/PASS/LAS, ENSA, BUT via ADIUT, connected L2/L3/licence pro/M1/M2, Polytech). Other institutions and double procedures require their own confirmation.';
export const legacyTemplates:TemplateDefinition[]=[
 template('ucas-2027-standard','UCAS 2027 — standard undergraduate','GB','undergraduate','undergraduate_standard','equal_consideration',standardScope,[ucasStandard,ucas],[
  card('course-scope','Confirm course requirements and deadline',standardScope),
  card('application','Prepare application and academic reference','Prepare qualifications, course choices, personal statement answers and an academic reference. Set a separate personal school/referee deadline.'),
  card('submit','Submit UCAS application','Equal consideration deadline; school internal deadlines may be earlier.',deadline('2027-01-13T18:00:00Z','Europe/London',[ucasStandard],'equal_consideration',standardScope)),
 ]),
 template('ucas-2027-early','UCAS 2027 — October deadline courses','GB','undergraduate','undergraduate_early','october',earlyScope,[ucas],[
  card('course-scope','Confirm October course applicability',earlyScope),
  card('admissions-tests','Check tests and registration deadlines','Course-specific tests, interviews and registration deadlines need separate official confirmation.'),
  card('application','Prepare application and academic reference','Allow time for the school or referee to review and submit.'),
  card('submit','Submit UCAS application','Deadline is 18:00 UK time, including the academic reference.',deadline('2026-10-15T17:00:00Z','Europe/London',[ucas],'october',earlyScope)),
 ]),
 template('common-app-2027','Common App 2026–27 — college specific','US','first_year','first_year','college_specific','2026–27 application season for 2027 entry. Select each college and its actual ED/EA/REA/RD/rolling round; there is no shared submission deadline.',[common],[
  card('college-list','Confirm colleges, programs and application rounds','Record official institution links and verify requirements. Early decision obligations require institution-specific review.'),
  card('application','Prepare profile and college supplements','Prepare activities/experiences, essays and each selected college supplement.'),
  card('recommendations','Coordinate school documents and recommendations','Check each college requirements and set personal school/referee milestones.'),
  card('submit','Confirm and record the chosen college deadline','Enter the institution and round-specific date after checking its official page; a default November/January date is not supplied.',deadline(null,'America/New_York',[common],'college_specific','Institution, round and local deadline timezone must be confirmed separately.')),
 ]),
 template('bocconi-2027-winter-international','Bocconi 2027–28 — international Winter','IT','international','bachelor_or_law_standard','winter',internationalScope,[bocconi],[
  card('category','Confirm applicant category and program',internationalScope),
  card('test','Obtain a valid selection test score','Confirm accepted test for your program. Test booking closes before the application deadline; check current slot availability and required advance booking.'),
  card('documents','Prepare transcripts, identification and score report','Check diploma and language conditions on the university site.'),
  card('submit','Submit Winter application','Application submission, including required test score, by 15:00 Italian time.',deadline('2027-01-26T14:00:00Z','Europe/Rome',[bocconi],'winter',internationalScope)),
 ]),
 template('bocconi-2027-early-international','Bocconi 2027–28 — international Early (closed)','IT','international','bachelor_or_law_standard','early',internationalScope+' Early closed before this source review; this template is retained for historical planning, not as an open opportunity.',[bocconi],[
  card('category','Confirm applicant category and program',internationalScope),
  card('submit','Early application deadline (already passed)','For historical tracking. Consider current Winter selection if eligible.',deadline('2026-09-29T13:00:00Z','Europe/Rome',[bocconi],'early',internationalScope)),
 ]),
 template('campus-france-maroc-2027','Campus France Morocco 2026/27 — 2027 entry','FR','morocco_procedure','etudes_en_france_connected_or_dap','2026_27_procedure',campusScope,[campus],[
  card('procedure','Confirm Morocco procedure and institution',campusScope),
  card('language','Check French certification and exemptions','Check TCF/DELF/DALF requirements and current test availability; no guessed test deadline.'),
  card('documents','Prepare Études en France application','Select eligible programs and gather required academic documents. Check any additional institution procedure.'),
  card('submit','Submit Campus France Morocco application','Submission deadline at 23:59 Morocco time.',deadline('2026-11-15T22:59:00Z','Africa/Casablanca',[campus],'2026_27_procedure',campusScope)),
 ],['MA']),
];

const commonGuide='https://www.commonapp.org/apply/first-year-students/';
const aidGuide='https://cssprofile.collegeboard.org/';
const satDates='https://satsuite.collegeboard.org/sat/dates-deadlines';
const satScores='https://satsuite.collegeboard.org/scores/score-release-dates';
const reviewedAt='2026-10-10T18:00:00.000Z';
// Suggested milestones are dated personal plans requiring confirmation. They
// are neither source-verified deadlines nor dates the student has already set.
function suggested(cycle:number,date:string,round:string,scope:string,sourceUrls:string[]=[],timeZone='Etc/UTC'):Deadline {
 return {kind:'personal',dueAt:`${date}T12:00:00Z`,timeZone,sourceUrls,cycle,round,applicability:`Suggested preparation target; confirm and adapt to your institution and personal schedule. ${scope}`,status:'requires_confirmation',verifiedAt:null};
}
function official(cycle:number,dueAt:string,timeZone:string,round:string,scope:string,sourceUrls:string[]):Deadline {
 return {kind:'official',dueAt,timeZone,sourceUrls,cycle,round,applicability:scope,status:'verified',verifiedAt:reviewedAt};
}
function satCards(cycle:number):TemplateCard[] {
 const y=cycle-1,scope='Only if the chosen college accepts SAT scores for this round. Confirm its final accepted test, self-reporting and score receipt rules; allow processing time.';
 const prep=(key:string,title:string,date:string,round:string,description:string)=>card(key,title,description,suggested(cycle,date,round,scope,[satDates,satScores]));
 const earlyTest=cycle===2027?'2026-10-03':`${y}-10-01`,regularTest=cycle===2027?'2026-12-05':`${y}-12-01`;
 const cards=[
  prep('sat-preparation','SAT — practice and choose testing plan',`${y}-06-15`,'testing','Take an official practice test, identify topics to study and plan an earlier attempt with time to retest. Check whether each college requires or accepts scores.'),
  prep('sat-early-registration','SAT for ED/EA — registration',cycle===2027?'2026-09-18':`${y}-09-01`,'ed_ea','Register for a test whose score release precedes your early round. Check test center places, accommodations and any earlier device-lending request date.'),
  prep('sat-early-test','SAT for ED/EA — October testing',earlyTest,'ed_ea',cycle===2027?'Official test date: October 3, 2026; scores October 16. This is the last scheduled fall SAT before the typical November 1 target. It is already past as of October 10; use an existing score or confirm later-test acceptance with the college. The date marker is a preparation reminder; your admission ticket specifies local arrival time.':'Suggested October testing window, not a published test appointment. Confirm the official calendar, registration and score-release dates when available.'),
  prep('sat-early-scores','ED/EA — check scores and reporting',`${y}-10-20`,'ed_ea','Check available scores and institution reporting instructions. November testing is too late for a November 1 deadline unless the college explicitly accepts scores afterwards.'),
  prep('sat-rd-registration','SAT for RD — registration',cycle===2027?'2026-11-20':`${y}-11-01`,'regular_decision','If needed, register for a final regular-round attempt; confirm that the college accepts December scores. Plan an earlier test where possible.'),
  prep('sat-rd-test','SAT for RD — December testing',regularTest,'regular_decision',cycle===2027?'Official test date: December 5, 2026; scores December 18. Confirm receipt/self-reporting rules before relying on this for January applications. Your admission ticket specifies local arrival time.':'Suggested December testing window, not an official test date. Confirm the published calendar and the college’s last accepted test.'),
  prep('sat-rd-scores','RD — check scores and reporting',`${y}-12-20`,'regular_decision','Check scores and complete score reporting with processing time before the college deadline.'),
 ];
 if(cycle===2027){
  cards[1]!.deadline=official(cycle,'2026-09-19T03:59:00Z','America/New_York','ed_ea','College Board October SAT standard registration deadline, September 18 at 23:59 ET. Not a college admissions deadline.',[satDates]);
  cards[4]!.deadline=official(cycle,'2026-11-21T04:59:00Z','America/New_York','regular_decision','College Board December SAT standard registration deadline, November 20 at 23:59 ET. Not a college admissions deadline.',[satDates]);
 }
 return cards;
}
function commonCards(cycle:number):TemplateCard[] {
 const y=cycle-1,scope='Each college sets its own requirements, deadline and timezone. ED, EA, REA and RD eligibility must be confirmed separately.';
 const task=(key:string,title:string,date:string,round:string,description:string,urls=[commonGuide])=>card(key,title,description,suggested(cycle,date,round,scope,urls));
 return [
  task('college-list','Confirm colleges, programs and application rounds',`${y}-08-15`,'college_specific',scope+' Record official institution URLs, testing policies, financial aid requirements and actual deadlines.'),
  task('application','Prepare profile, activities and main essay',`${y}-09-15`,'college_specific','Prepare application details and a first essay draft; reserve time for feedback.'),
  task('recommendations','Request school documents and recommendations',`${y}-09-15`,'college_specific','Ask counselors and teachers early; agree personal school/referee deadlines for each round.'),
  task('early-supplements','ED/EA — finish supplements and review',`${y}-10-15`,'ed_ea','Review essays, activities, school documents and the early-round choice. Confirm any binding agreement and affordability before choosing ED.'),
  task('submit','ED/EA — November 1 typical target; confirm college',`${y}-11-01`,'ed_ea','November 1 is a typical suggested planning target, not a universal admissions deadline. Replace it with the exact selected institution/round date and timezone; some colleges use other dates.'),
  task('rd-supplements','RD — finish supplements and review',`${y}-12-15`,'regular_decision','Complete regular-round essays and check documents and any additional program requirements.'),
  task('rd-submit','RD — January 1 typical target; confirm college',`${cycle}-01-01`,'regular_decision','January 1 is a typical suggested planning target, not a universal admissions deadline. Confirm the selected institution/round date and timezone, including earlier scholarship deadlines.'),
  task('financial-aid-plan','Financial aid — confirm eligibility and required forms',`${y}-09-01`,'financial_aid','Record each college’s separate priority aid and scholarship deadlines. Confirm international applicant eligibility, CSS Profile or institution forms, and FAFSA only if eligible.',[commonGuide,aidGuide]),
  task('financial-aid-documents','Financial aid — prepare family financial documents',`${y}-10-01`,'financial_aid','Gather requested income, tax and asset documents with the family; check translations and the actual available application cycle.',[aidGuide]),
  task('financial-aid-early','ED/EA financial aid — personal preparation target',`${y}-10-25`,'ed_ea','Prepare and submit required aid forms when available before the institution’s confirmed priority deadline. October 25 is a personal planning target, not an official aid deadline.',[aidGuide]),
  task('financial-aid-rd','RD financial aid — personal preparation target',`${y}-12-15`,'regular_decision','Prepare required regular-round aid forms and scholarships before the confirmed institution deadline. December 15 is a personal preparation target.',[aidGuide]),
  ...satCards(cycle),
 ];
}

/** Generate an immutable planning release for an entry year, never extrapolating
 * a source-verified calendar into a future official deadline. */
export function templatesForCycle(cycle:number):TemplateDefinition[] {
 if(!Number.isInteger(cycle)||cycle<2027||cycle>2200)throw new RangeError('Use an entry cycle from 2027 to 2200');
 const y=cycle-1;
 const cycleText=(text:string)=>text.replace(/2027–28|2026–27|2026\/27|2027/g,value=>({
  '2027–28':`${cycle}–${String(cycle+1).slice(-2)}`,'2026–27':`${y}–${String(cycle).slice(-2)}`,'2026/27':`${y}/${String(cycle).slice(-2)}`,'2027':String(cycle),
 })[value]!);
 return legacyTemplates.map(base=>{
  const future=cycle!==2027,scope=cycleText(base.applicability).replace(/ Early closed before this source review;.*$/,'');
  const t:TemplateDefinition={...base,key:base.key.replace('2027',String(cycle)),version:future?1:2,cycle,name:cycleText(base.name).replace(future?' (closed)':'__none__',''),round:base.key.startsWith('campus-france')?`${y}_${String(cycle).slice(-2)}_procedure`:base.round,applicability:scope,verifiedAt:future?null:reviewedAt,sourceUrls:base.sourceUrls,applicantCountries:[...base.applicantCountries],columns:[...base.columns],cards:[]};
  if(base.key.startsWith('common-app')){
   t.name=`Common App ${cycle} entry (${y}–${String(cycle).slice(-2)}) — ED/EA, RD, aid and SAT`;
   t.applicability=`${cycle} entry first-year planning. November 1 and January 1 are typical suggested targets to confirm for each selected college. Future calendar reminders are personal preparation goals.`;
   t.sourceUrls=[commonGuide,aidGuide,satDates,satScores];t.verifiedAt=cycle===2027?reviewedAt:null;t.cards=commonCards(cycle);return t;
  }
  // Preserve all old card keys, so existing boards receive reviewable date
  // suggestions instead of silently replacing cards or manual dates.
  const dates:Record<string,Record<string,string>>={
   undergraduate_standard:{'course-scope':`${y}-09-01`,application:`${y}-12-01`,submit:`${cycle}-01-10`},
   undergraduate_early:{'course-scope':`${y}-06-01`,'admissions-tests':`${y}-08-01`,application:`${y}-09-15`,submit:`${y}-10-01`},
   bachelor_or_law_standard:{category:`${y}-${base.round==='early'?'06':'10'}-01`,test:base.round==='early'?`${y}-09-01`:`${cycle}-01-10`,documents:base.round==='early'?`${y}-08-15`:`${y}-12-15`,submit:base.round==='early'?`${y}-09-20`:`${cycle}-01-15`},
   etudes_en_france_connected_or_dap:{procedure:`${y}-06-01`,language:`${y}-07-01`,documents:`${y}-10-15`,submit:`${y}-11-01`},
  };
  t.cards=base.cards.map(original=>({...original,checklist:[],references:[],title:future?original.title.replace(' (already passed)',''):original.title,description:future&&original.key==='submit'?`Suggested submission preparation target. The official date for this entry cycle has not been verified; confirm its published calendar. ${scope}`:cycleText(original.description),deadline:!future&&original.deadline?.status==='verified'?{...original.deadline,verifiedAt:reviewedAt}:suggested(cycle,dates[base.program]![original.key]!,t.round,scope,base.sourceUrls)}));
  return t;
 });
}
// Retain the original release for detail/review and reproducible existing boards.
export const builtInTemplates:TemplateDefinition[]=[...legacyTemplates,...[2027,2028,2029,2030,2031].flatMap(templatesForCycle)];
export function cycleForSystemKey(key:string):number|undefined {
 const match=/^(?:ucas-(\d{4})-(?:standard|early)|common-app-(\d{4})|bocconi-(\d{4})-(?:winter|early)-international|campus-france-maroc-(\d{4}))$/.exec(key);
 const cycle=match?Number(match.slice(1).find(Boolean)):undefined;
 return cycle!==undefined&&cycle>=2027&&cycle<=2200?cycle:undefined;
}
