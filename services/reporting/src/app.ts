import 'reflect-metadata';
import { AttributionController, AttributionRedirectController, AttributionService } from './attribution.js';
import { ReportingController } from './reporting.controller.js';
import { ReportingService } from './reporting.service.js';
import { ReconcileService } from './reconcile.service.js';
import { ReportingProjection } from './projections.js';
import { BusinessDashboardController, BusinessDashboardService } from './business-dashboard.js';
export const appOptions = {
    name: 'reporting', port: 4010, entitlement: 'reporting', controllers: [ReportingController, AttributionController, AttributionRedirectController, BusinessDashboardController], providers: [ReportingService, ReconcileService, ReportingProjection, AttributionService, BusinessDashboardService]
};
