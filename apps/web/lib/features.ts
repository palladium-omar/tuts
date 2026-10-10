import { hasPermission } from '@palladium/contracts';
import type { Business } from './api';

export interface FeatureAccess {
  id: string;
  entitlement: string;
  permission?: string;
  dependencies?: readonly string[];
}

/** Shared navigation gate. APIs repeat these checks using signed context. */
export function canUseFeature(business: Business, feature: FeatureAccess): boolean {
  return business.entitlements.includes(feature.entitlement) &&
    hasPermission(business, feature.permission ?? `${feature.entitlement}.read`) &&
    (feature.dependencies ?? []).every(dependency => business.entitlements.includes(dependency));
}
