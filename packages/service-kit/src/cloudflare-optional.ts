// Wrangler aliases Nest's absent optional peers here. No SocketModule or
// MicroservicesModule is exported, so Nest retains its normal HTTP-only path.
// This runtime uses Zod; accidentally enabling Nest's optional validator or
// serializer must fail explicitly instead of silently skipping validation.
function unavailable(): never {
  throw new Error('Optional Nest validation, serialization and microservice peers are unavailable in this Worker');
}
export const validate = unavailable;
export const validateSync = unavailable;
export const plainToInstance = unavailable;
export const instanceToPlain = unavailable;
export const classToPlain = unavailable;
