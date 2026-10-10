/** Capability presets are provisioning defaults, never resource ownership. */
export const permissionNames = [
  'platform.read', 'platform.write',
  'clients.read', 'clients.write', 'clients.merge', 'clients.groups.manage',
  'scheduling.read', 'scheduling.write', 'learning.read', 'learning.write',
  'billing.read', 'billing.write', 'billing.manage',
  'payments.read', 'payments.write', 'payments.manage',
  'integrations.read', 'integrations.write', 'integrations.manage',
  'notifications.read', 'notifications.write', 'notifications.manage',
  'planning.read', 'planning.write', 'reporting.read', 'reporting.write',
  'reporting.financial', 'platform.invites.manage',
] as const;
export type Permission = (typeof permissionNames)[number];
export interface PermissionSubject {
  role: string;
  permissions?: readonly string[];
  accessScope?: 'business' | 'students';
  studentIds?: readonly string[];
}

export function defaultPermissions(role: string): Permission[] {
  if (role === 'owner' || role === 'admin') return [...permissionNames];
  if (role === 'tutor') return permissionNames.filter(permission =>
    !['platform.write', 'billing.manage', 'payments.manage', 'integrations.manage',
      'notifications.manage'].includes(permission));
  if (role === 'student' || role === 'parent') return [
    'clients.read', 'scheduling.read', 'learning.read', 'learning.write',
    'planning.read', 'planning.write', 'reporting.read', 'reporting.write',
    'billing.read', 'payments.read', 'integrations.read',
  ];
  return [];
}

/** An explicit empty override denies all actions. No wildcards or role bypass. */
export function hasPermission(subject: PermissionSubject, permission: string): boolean {
  return (subject.permissions ?? defaultPermissions(subject.role)).includes(permission);
}

export function canAccessStudent(subject: PermissionSubject, studentId: string): boolean {
  const scope = subject.accessScope ??
    (['owner', 'admin', 'tutor'].includes(subject.role) ? 'business' : 'students');
  if (scope === 'business' && !['student', 'parent'].includes(subject.role)) return true;
  return (subject.studentIds ?? []).includes(studentId);
}

export function canReadFinancial(subject: PermissionSubject): boolean {
  return hasPermission(subject, 'billing.read') && hasPermission(subject, 'reporting.financial');
}
