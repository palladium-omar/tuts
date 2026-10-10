export type PlanningProfile = {
  currentGrade?: number;
  /** September starting year for the recorded grade; never advanced implicitly. */
  academicYear?: number;
  graduationYear?: number;
  entryCycle?: number;
  applicantCountry?: string;
  templateKey?: string;
};
export type ApplicationCycle = { cycle: number; source: "entry" | "graduation" | "grade"; graduationYear?: number; reason?: never } | { cycle: null; reason: string; source?: never; graduationYear?: never };
const year = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 2000 && value <= 2200;

export function currentAcademicYear(now = new Date(), timeZone = "UTC"): number {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "numeric" }).formatToParts(now);
  const calendarYear = Number(parts.find(part => part.type === "year")!.value), month = Number(parts.find(part => part.type === "month")!.value);
  return month >= 9 ? calendarYear : calendarYear - 1;
}

export function applicationCycle(value: unknown): ApplicationCycle {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { cycle: null, reason: "Choose your current grade or expected graduation year." };
  const profile = value as PlanningProfile;
  if (profile.currentGrade !== undefined && (!Number.isInteger(profile.currentGrade) || profile.currentGrade < 9 || profile.currentGrade > 12)) return { cycle: null, reason: "Confirm your current grade or expected graduation year." };
  if ([profile.academicYear, profile.graduationYear, profile.entryCycle].some(value => value !== undefined && !year(value))) return { cycle: null, reason: "Confirm the school year and expected graduation year." };
  const derived = profile.currentGrade !== undefined && profile.academicYear !== undefined ? profile.academicYear + 13 - profile.currentGrade : undefined;
  if (derived !== undefined && !year(derived)) return { cycle: null, reason: "Confirm the school year and expected graduation year." };
  if (derived !== undefined && profile.graduationYear !== undefined && derived !== profile.graduationYear) return { cycle: null, reason: "Your grade and school year disagree with expected graduation. Which is correct?" };
  const graduation = profile.graduationYear ?? derived;
  if (profile.entryCycle !== undefined) {
    if (graduation !== undefined && profile.entryCycle < graduation) return { cycle: null, reason: "University entry is before expected graduation. Confirm these years." };
    return { cycle: profile.entryCycle, source: "entry", graduationYear: graduation };
  }
  if (profile.graduationYear !== undefined) return { cycle: profile.graduationYear, source: "graduation", graduationYear: profile.graduationYear };
  if (derived !== undefined) return { cycle: derived, source: "grade", graduationYear: derived };
  return { cycle: null, reason: profile.currentGrade !== undefined ? "Which school year is this grade for?" : "Choose your current grade or expected graduation year." };
}

// This identity invalidates pending template reads and route selections when
// education facts change, even if both profiles happen to resolve to one cycle.
export function planningProfileKey(value: PlanningProfile | null | undefined): string {
  return JSON.stringify([value?.currentGrade, value?.academicYear, value?.graduationYear, value?.entryCycle, value?.applicantCountry, value?.templateKey]);
}
