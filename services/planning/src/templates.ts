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
export const builtInTemplates:TemplateDefinition[]=[
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
