import { z } from "zod";

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

const year = z.number().int().min(2000).max(2200);
export const planningProfileSchema = z.object({
  currentGrade: z.number().int().min(9).max(12).optional(),
  academicYear: year.max(2199).optional(),
  graduationYear: year.optional(),
  entryCycle: year.optional(),
  // Explicit staff facts used to preselect an applicable template. Never inferred.
  applicantCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  applicantFacts: applicantFactsSchema.optional(),
  templateKey: z.string().trim().min(1).max(160).regex(/^[a-z0-9-]+$/).optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Provide an education fact, or null to clear the profile")
  .refine(value => value.currentGrade === undefined || value.academicYear === undefined || value.academicYear + 13 - value.currentGrade <= 2200, "Expected graduation must be at most 2200")
  .refine(value => value.currentGrade === undefined || value.academicYear === undefined || value.graduationYear === undefined || value.graduationYear === value.academicYear + 13 - value.currentGrade, "Grade and school year disagree with expected graduation; confirm the education facts")
  .refine(value => value.entryCycle === undefined || value.entryCycle >= (value.graduationYear ?? (value.currentGrade !== undefined && value.academicYear !== undefined ? value.academicYear + 13 - value.currentGrade : 2000)), "University entry cannot be before expected graduation");

export type PlanningProfile = z.infer<typeof planningProfileSchema>;

// The portal receives only the explicitly approved education facts. Use a
// whitelist even for old data, rather than spreading a JSON field into a response.
export function studentPlanningProfile(value: unknown) {
  const parsed = planningProfileSchema.safeParse(value);
  if (!parsed.success) return null;
  const { currentGrade, academicYear, graduationYear, entryCycle, applicantFacts } = parsed.data;
  const education = Object.fromEntries(Object.entries({ currentGrade, academicYear, graduationYear, entryCycle, applicantFacts }).filter(([, item]) => item !== undefined));
  return Object.keys(education).length ? education : null;
}
