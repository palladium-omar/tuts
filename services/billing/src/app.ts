import "reflect-metadata";
import { StudentFinanceController, StudentFinanceService } from "./student-finance.js";
import { StudentWorkHistoryService } from './student-work-history.js';
import { StudentWorkHistoryController } from './student-work-history.controller.js';
import { MonthlyController, MonthlyService } from "./monthly.js";
import { BillingController, BillingService } from "./billing.js";
import { HistoryService } from './history.js';
import { HistoryIdentityService } from './history-identity.js';
import { HistoryStudentsService } from './history-students.js';
import { HistoryStudentsController } from './history-students.controller.js';
import { HistoryAnalyticsService } from './history-analytics.js';
import { HistoryImportsController, WorkLogController, InvoiceHistoryController, BusinessAnalyticsController } from './history.controller.js';
export const appOptions = {
  name: "billing",
  port: 4005,
  controllers: [BillingController, MonthlyController, StudentFinanceController, StudentWorkHistoryController, HistoryImportsController, HistoryStudentsController, WorkLogController, InvoiceHistoryController, BusinessAnalyticsController],
  providers: [BillingService, MonthlyService, StudentFinanceService, StudentWorkHistoryService, HistoryService, HistoryAnalyticsService, HistoryIdentityService, HistoryStudentsService],
  entitlement: "billing",
};
