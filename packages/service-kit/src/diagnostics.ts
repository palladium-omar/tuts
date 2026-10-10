import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

type Scope = { service: string; requestId: string; trigger: 'http' | 'scheduled' | 'queue'; businessId?: string };
const scopes = new AsyncLocalStorage<Scope>();
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export function diagnosticId(value?: unknown): string {
  return typeof value === 'string' && uuid.test(value) ? value : randomUUID();
}
export function withDiagnostics<T>(scope: Scope, work: () => T): T {
  return scopes.run({ ...scope, requestId: diagnosticId(scope.requestId) }, work);
}
/** Snapshot ownership before an asynchronous resource can emit in another scope. */
export function captureDiagnosticScope(): <T>(work: () => T) => T {
  const current = scopes.getStore();
  const owner = current ? { ...current } : undefined;
  return work => owner ? scopes.run(owner, work) : scopes.exit(work);
}
export function currentDiagnosticId(): string | undefined { return scopes.getStore()?.requestId; }
/** Only call after signed context verification, never from a tenant header. */
export function diagnosticBusiness(businessId: string): void {
  const scope = scopes.getStore();
  if (scope && uuid.test(businessId)) scope.businessId = businessId;
}

const segments = new Set(('api platform clients scheduling learning billing payments notifications integrations planning reporting portal students groups members invitations accept resend access sender-status summaries summary boards columns tasks templates instantiate attribution active submission-upload google-docs booking booking-config calcom-webhook contacts duplicates merge preview dismiss finance auth v1 internal __runtime tick health context auth-mail status password-reset request-password-reset reset-password sign-in sign-up email sign-out get-session businesses profile resources assignments sessions calendar classes ledger connectors connections sync imports fields campaigns recipients invoices rates settings monthly reconcile checkout attempts activity hooks openapi.json').split(' '));
/** No query strings, identifiers, arbitrary names, or webhook path secrets. */
export function diagnosticRoute(path: string): string {
  return path.split('?')[0]!.split('/').slice(0, 9).map(part => segments.has(part) ? part : part ? ':param' : '').join('/');
}
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AggregateError', 'AuthMailDeliveryError', 'StripeError', 'CommunicationError', 'ServiceUnavailableException', 'UnauthorizedException', 'ForbiddenException', 'BadGatewayException', 'BadRequestException', 'ConflictException', 'UnprocessableEntityException']);
const codes = new Set(['23505','23P01','22P02','23514','22007','53300','53400','57P01','57P02','57P03','08000','08001','08003','08006','28P01','42501','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ERR_INVALID_URL']);
export function safeDiagnosticError(error: unknown) {
  const item = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; stack?: unknown } : {};
  const kind = typeof item.name === 'string' && names.has(item.name) ? item.name : 'UnknownError';
  const code = typeof item.code === 'string' && codes.has(item.code) ? item.code : undefined;
  // Retain code locations only. Discard the message, SQL details, URLs,
  // filesystem directories, arbitrary function names and attached objects.
  const locations = typeof item.stack === 'string' ? item.stack.split('\n').slice(1, 12).flatMap(line => {
    const match = /(?:\/|\s|\()([a-zA-Z0-9_.-]+\.(?:js|ts|mjs)):(\d+):(\d+)\)?$/.exec(line.trim());
    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  }).slice(0, 6) : [];
  return { kind, ...(code ? { code } : {}), locations };
}
type Event = 'auth_mail_provider_failed' | 'browser_error' | 'outbox_completed' | 'target_completed' | 'database_connected' | 'database_transaction' | 'request_completed' | 'request_failed' | 'api_error' | 'identity_failed' | 'upstream_failed' | 'tick_failed' | 'tick_completed' | 'queue_retry' | 'queue_failed' | 'outbox_deferred' | 'background_failed' | 'cleanup_failed' | 'database_failed' | 'password_mail_failed' | 'password_mail_not_configured';
type Fields = { providerStatus?: number; failureCategory?: string; browserKind?: string; source?: string; view?: string; count?: number; status?: number; durationMs?: number; identityMs?: number; upstreamMs?: number; method?: string; route?: string; target?: string; error?: unknown };
/** Deliberately whitelist fields; never spread an error/request/provider result. */
export function logDiagnostic(level: 'info' | 'warn' | 'error', event: Event, fields: Fields = {}): void {
  const scope = scopes.getStore();
  const record = {
    schema: 'tuts.diagnostic.v1', timestamp: new Date().toISOString(), level, event,
    service: scope?.service ?? 'runtime', requestId: scope?.requestId ?? null,
    trigger: scope?.trigger ?? null, businessId: scope?.businessId ?? null,
    ...(fields.browserKind && ['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError','UnknownError'].includes(fields.browserKind) ? {browserKind:fields.browserKind} : {}),
    ...(fields.source && ['window','promise'].includes(fields.source) ? {source:fields.source} : {}),
    ...(fields.view && ['dashboard','crm','tracker','scheduling','learning','planning','other'].includes(fields.view) ? {view:fields.view} : {}),
    ...(Number.isInteger(fields.count) && fields.count!>0 && fields.count!<=10 ? {count:fields.count} : {}),
    ...(Number.isInteger(fields.providerStatus) && fields.providerStatus! >= 100 && fields.providerStatus! <= 599 ? {providerStatus: fields.providerStatus} : {}),
    ...(fields.failureCategory && ['network','timeout','provider_rejected','invalid_response','response_limit','runtime_type_error'].includes(fields.failureCategory) ? {failureCategory: fields.failureCategory} : {}),
    ...(Number.isInteger(fields.status) ? { status: fields.status } : {}),
    ...(Number.isFinite(fields.durationMs) ? { durationMs: Math.max(0, Math.round(fields.durationMs!)) } : {}),
    ...(Number.isFinite(fields.identityMs) ? { identityMs: Math.max(0, Math.round(fields.identityMs!)) } : {}),
    ...(Number.isFinite(fields.upstreamMs) ? { upstreamMs: Math.max(0, Math.round(fields.upstreamMs!)) } : {}),
    ...(fields.method && ['GET','HEAD','POST','PATCH','PUT','DELETE','OPTIONS'].includes(fields.method) ? { method: fields.method } : {}),
    ...(fields.route ? { route: diagnosticRoute(fields.route) } : {}),
    ...(fields.target && segments.has(fields.target) ? { target: fields.target } : {}),
    ...(fields.error !== undefined ? { error: safeDiagnosticError(fields.error) } : {}),
  };
  console[level === 'info' ? 'log' : level](JSON.stringify(record));
}
