import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function requestHash(input: unknown): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}
export async function idempotent<T>(
  tx: PoolClient,
  businessId: string,
  operation: string,
  key: unknown,
  input: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(key))
    throw new BadRequestException("valid_idempotency_key_required");
  const hash = requestHash(input);
  await tx.query(
    "INSERT INTO billing_idempotency (business_id,operation,key,request_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [businessId, operation, key, hash],
  );
  const { rows } = await tx.query(
    "SELECT request_hash,response FROM billing_idempotency WHERE business_id=$1 AND operation=$2 AND key=$3 FOR UPDATE",
    [businessId, operation, key],
  );
  if (!rows[0] || rows[0].request_hash !== hash)
    throw new ConflictException("idempotency_key_payload_mismatch");
  if (rows[0].response !== null) return rows[0].response as T;
  const result = await work();
  await tx.query(
    "UPDATE billing_idempotency SET response=$4::jsonb WHERE business_id=$1 AND operation=$2 AND key=$3",
    [businessId, operation, key, JSON.stringify(result)],
  );
  return result;
}
