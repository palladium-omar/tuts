import "reflect-metadata";
import { StudentFinanceController, StudentFinanceService } from "./student-finance.js";
import { MonthlyController, MonthlyService } from "./monthly.js";
import { BillingController, BillingService } from "./billing.js";
import { HistoryService } from './history.js';
import { HistoryIdentityService } from './history-identity.js';
import { HistoryAnalyticsService } from './history-analytics.js';
import { HistoryImportsController, WorkLogController, InvoiceHistoryController, BusinessAnalyticsController } from './history.controller.js';
export const appOptions = {
  name: "billing",
  port: 4005,
  controllers: [BillingController, MonthlyController, StudentFinanceController, HistoryImportsController, WorkLogController, InvoiceHistoryController, BusinessAnalyticsController],
  providers: [BillingService, MonthlyService, StudentFinanceService, HistoryService, HistoryAnalyticsService, HistoryIdentityService],
  entitlement: "billing",
};
