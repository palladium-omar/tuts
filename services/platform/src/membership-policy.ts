import { defaultPermissions, type RequestContext } from "@palladium/contracts";
import type { PoolClient } from "pg";

export type MembershipPolicyRow = {
  role: RequestContext["role"];
  permissions_override: string[] | null;
  access_scope: "business" | "students";
};

export type MembershipPolicy = {
  permissions: string[];
  accessScope: "business" | "students";
  studentIds: string[];
  policyVersion: 1;
};

/** Resolve only persisted relationship grants inside the current tenant. */
export async function membershipPolicy(
  tx: PoolClient,
  userId: string,
  row: MembershipPolicyRow,
): Promise<MembershipPolicy> {
  const accessScope = row.role === "student" || row.role === "parent"
    ? "students"
    : row.access_scope;
  const studentIds = accessScope === "students"
    ? (await tx.query<{ student_id: string }>(
      "SELECT student_id FROM portal_student_access WHERE user_id=$1 AND revoked_at IS NULL ORDER BY student_id",
      [userId],
    )).rows.map((grant) => grant.student_id)
    : [];
  return {
    permissions: [...new Set(row.permissions_override ?? defaultPermissions(row.role))],
    accessScope,
    studentIds,
    policyVersion: 1,
  };
}
