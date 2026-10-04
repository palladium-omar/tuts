import { z } from "zod";
import { featureNames } from "@palladium/contracts";

export const businessIdSchema = z.uuid();
export const timezoneSchema = z
  .string()
  .max(80)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone");
const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();
export const profileSchema = z
  .object({
    legalName: optionalText(200),
    email: z.email().max(254).nullable().optional(),
    phone: optionalText(50),
    website: z
      .url()
      .max(2048)
      .refine(
        (v) => ["https:", "http:"].includes(new URL(v).protocol),
        "Use an HTTP or HTTPS website",
      )
      .nullable()
      .optional(),
    taxId: optionalText(100),
    address: z
      .object({
        line1: optionalText(200),
        line2: optionalText(200),
        city: optionalText(120),
        region: optionalText(120),
        postalCode: optionalText(30),
        country: optionalText(100),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const MAX_LOGO_BYTES = 256 * 1024;
export function validLogoDataUrl(value: string): boolean {
  const match =
    /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2]!.length % 4 !== 0) return false;
  const bytes = Buffer.from(match[2]!, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_LOGO_BYTES ||
    bytes.toString("base64") !== match[2]
  )
    return false;
  if (match[1] === "png")
    return (
      bytes.length >= 24 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString("ascii", 12, 16) === "IHDR"
    );
  if (match[1] === "jpeg")
    return (
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 &&
      bytes[bytes.length - 1] === 217
    );
  return (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)) &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  );
}
export const brandingSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    primaryColor: color.optional(),
    secondaryColor: color.optional(),
    backgroundColor: color.optional(),
    textColor: color.optional(),
    logoUrl: z
      .url()
      .max(2048)
      .refine((v) => v.startsWith("https://"), "Logo URL must use HTTPS")
      .nullable()
      .optional(),
    logoDataUrl: z
      .string()
      .max(350000)
      .refine(
        validLogoDataUrl,
        "Logo must be a valid PNG, JPEG or WebP of at most 256 KiB",
      )
      .nullable()
      .optional(),
  })
  .strict();
export const businessSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    timezone: timezoneSchema.default("UTC"),
    profile: profileSchema.optional(),
    branding: brandingSchema.optional(),
  })
  .strict();
export const settingsSchema = z
  .object({
    profile: profileSchema.optional(),
    branding: brandingSchema.optional(),
    timezone: timezoneSchema.optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one setting is required");
export const internalContextSchema = z
  .object({ businessId: businessIdSchema })
  .strict();
export const STARTER_ENTITLEMENTS = [
  "clients",
  "scheduling",
  "learning",
  "billing",
  "payments",
  "notifications",
  "integrations",
];
export function starterEntitlements(
  environment = process.env.NODE_ENV,
): string[] {
  return environment === "production" ? [] : [...STARTER_ENTITLEMENTS];
}
/** Server deployment policy only; browser payloads never select entitlements. */
export function initialBusinessEntitlements(
  environment = process.env.NODE_ENV,
  configured = process.env.INITIAL_BUSINESS_ENTITLEMENTS,
): string[] {
  if (configured === undefined) return starterEntitlements(environment);
  if (!configured.trim()) return [];
  const entitlements = configured.split(",").map((value) => value.trim());
  const invalid = entitlements.filter(
    (value) => !featureNames.some((feature) => feature === value),
  );
  if (invalid.length)
    throw new Error(
      `INITIAL_BUSINESS_ENTITLEMENTS contains unknown or empty features: ${invalid.map((value) => value || "<empty>").join(", ")}. Allowed features: ${featureNames.join(", ")}`,
    );
  return [...new Set(entitlements)];
}
/** Explicit null clears a value; absent nested keys retain saved identity and palette. */
export function mergeSettings(
  current: Record<string, unknown>,
  input: z.infer<typeof settingsSchema>,
): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {
    ...current,
    ...Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ),
    version: 1,
  };
  if (input.branding)
    next.branding = { ...record(current.branding), ...input.branding };
  if (input.profile) {
    const profile = { ...record(current.profile), ...input.profile };
    if (input.profile.address)
      profile.address = {
        ...record(record(current.profile).address),
        ...input.profile.address,
      };
    next.profile = profile;
  }
  return next;
}
