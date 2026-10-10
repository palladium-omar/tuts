import { z } from "zod";

const year = z.number().int().min(2000).max(2200);
export const planningProfileSchema = z.object({
  currentGrade: z.number().int().min(9).max(12).optional(),
  academicYear: year.max(2199).optional(),
  graduationYear: year.optional(),
  entryCycle: year.optional(),
  // Explicit staff facts used to preselect an applicable template. Never inferred.
  applicantCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
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
  const { currentGrade, academicYear, graduationYear, entryCycle } = parsed.data;
  const education = Object.fromEntries(Object.entries({ currentGrade, academicYear, graduationYear, entryCycle }).filter(([, item]) => item !== undefined));
  return Object.keys(education).length ? education : null;
}
