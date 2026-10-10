import { createParamDecorator, ExecutionContext, SetMetadata, Injectable, Inject, UnauthorizedException, ForbiddenException, type CanActivate } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { importSPKI, jwtVerify } from 'jose';
import { requestContextSchema, hasPermission, canAccessStudent, type RequestContext } from '@palladium/contracts';
import { diagnosticBusiness } from './diagnostics.js';
export const OPTIONS = 'PALLADIUM_SERVICE_OPTIONS';
export interface ServiceOptions { name: string; port: number; controllers: any[]; providers?: any[]; migrationsDir: string; entitlement?: string; }
export const Public = () => SetMetadata('palladium.public', true);
export const Roles = (...roles: RequestContext['role'][]) => SetMetadata('palladium.roles', roles);
export const Permissions = (...permissions: string[]) => SetMetadata('palladium.permissions', permissions);
/** Opt in only on controllers that filter and check every student-owned resource. */
export const StudentScoped = () => SetMetadata('palladium.student-scoped', true);
export function assertStudentAccess(context: RequestContext, studentId: string): void {
  if (!canAccessStudent(context, studentId)) throw new ForbiddenException('Student access is not granted');
}
export function assertPermission(context: RequestContext, permission: string): void {
  if (!hasPermission(context, permission)) throw new ForbiddenException('This action is not permitted');
}
export const CurrentContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestContext => ctx.switchToHttp().getRequest().context);
@Injectable()
export class ContextGuard implements CanActivate {
  private key?: ReturnType<typeof importSPKI>;
  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(OPTIONS) private readonly options: ServiceOptions) {}
  async canActivate(execution: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride('palladium.public',[execution.getHandler(),execution.getClass()])) return true;
    const req = execution.switchToHttp().getRequest();
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) throw new UnauthorizedException('Verified service context required');
    try {
      this.key ??= importSPKI((process.env.CONTEXT_PUBLIC_KEY ?? '').replace(/\\n/g,'\n'),'EdDSA');
      const { payload } = await jwtVerify(auth.slice(7),await this.key,{issuer:'palladium-gateway',audience:'palladium-services',algorithms:['EdDSA'],maxTokenAge:'65s'});
      req.context = requestContextSchema.parse(payload);
    } catch { throw new UnauthorizedException('Invalid or expired service context'); }
    const context = req.context as RequestContext;
    diagnosticBusiness(context.businessId);
    if (this.options.entitlement && !context.entitlements.includes(this.options.entitlement)) throw new ForbiddenException('Feature is not enabled for this business');
    const permissions = this.reflector.getAllAndOverride<string[]>('palladium.permissions',[execution.getHandler(),execution.getClass()]);
    const explicitRoles = this.reflector.getAllAndOverride<RequestContext['role'][]>('palladium.roles',[execution.getHandler(),execution.getClass()]);
    if (explicitRoles && !explicitRoles.includes(context.role)) throw new ForbiddenException('Role cannot perform this operation');
    const scoped = context.accessScope === 'students' || ['student', 'parent'].includes(context.role);
    if (scoped && !this.reflector.getAllAndOverride<boolean>('palladium.student-scoped', [execution.getHandler(), execution.getClass()]))
      throw new ForbiddenException('Use a student-scoped endpoint');
    if (permissions) {
      for (const permission of permissions) assertPermission(context, permission);
    } else {
      const roles = this.reflector.getAllAndOverride<RequestContext['role'][]>('palladium.roles',[execution.getHandler(),execution.getClass()]) ?? ['owner','admin','tutor'];
      if (!roles.includes(context.role)) throw new ForbiddenException('Role cannot perform this operation');
      if (this.options.entitlement) assertPermission(context, `${this.options.entitlement}.${['GET','HEAD','OPTIONS'].includes(req.method) ? 'read' : 'write'}`);
      // Existing staff routes are not relationship-filtered. A scoped tutor must
      // use an explicitly scoped controller until these routes opt in.
    }
    return true;
  }
}
