import assert from "node:assert/strict";
import test from "node:test";
import { applicationCycle, currentAcademicYear, planningProfileKey } from "../lib/application-cycle";

test("the recorded 2026–27 grade selects the expected university entry cycle", () => {
  for (const [currentGrade, cycle] of [[12, 2027], [11, 2028], [10, 2029], [9, 2030]]) {
    assert.deepEqual(applicationCycle({ currentGrade, academicYear: 2026 }), { cycle, source: "grade", graduationYear: cycle });
  }
  // A saved 2025–26 grade stays tied to that year regardless of today's date.
  assert.equal(applicationCycle({ currentGrade: 11, academicYear: 2025 }).cycle, 2027);
});
test("explicit entry supports gap years; explicit graduation supports other school systems", () => {
  assert.equal(applicationCycle({ currentGrade: 12, academicYear: 2026, graduationYear: 2027, entryCycle: 2029 }).cycle, 2029);
  assert.equal(applicationCycle({ graduationYear: 2031 }).cycle, 2031);
  assert.equal(applicationCycle({ entryCycle: 2032 }).cycle, 2032);
});
test("unknown, malformed, inconsistent and out of range facts ask for clarification", () => {
  for (const value of [null, {}, { currentGrade: 11 }, { currentGrade: 8, academicYear: 2026 }, { currentGrade: 12, academicYear: "2026" }, { currentGrade: 12, academicYear: 2026, graduationYear: 2028 }, { graduationYear: 2028, entryCycle: 2027 }, { currentGrade: 9, academicYear: 2199 }, { displayName: "Class of 2027", email: "2031@example.test" }]) {
    assert.equal(applicationCycle(value).cycle, null);
  }
});
test("the September school year boundary follows the supplied timezone", () => {
  assert.equal(currentAcademicYear(new Date("2026-08-31T23:30:00Z"), "UTC"), 2025);
  assert.equal(currentAcademicYear(new Date("2026-08-31T23:30:00Z"), "Africa/Casablanca"), 2026);
  assert.equal(currentAcademicYear(new Date("2026-09-01T00:30:00Z"), "America/New_York"), 2025);
  assert.equal(currentAcademicYear(new Date("2027-01-01T00:00:00Z"), "UTC"), 2026);
});
test("profile identity changes when education or applicability changes, even within a cycle", () => {
  const original = { currentGrade: 12, academicYear: 2026 };
  assert.equal(planningProfileKey({ academicYear: 2026, currentGrade: 12 }), planningProfileKey(original));
  assert.notEqual(planningProfileKey(original), planningProfileKey({ graduationYear: 2027 }));
  assert.notEqual(planningProfileKey(original), planningProfileKey({ ...original, applicantCountry: "MA" }));
  assert.notEqual(planningProfileKey(original), planningProfileKey({ currentGrade: 11, academicYear: 2026 }));
});
