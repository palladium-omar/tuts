import "reflect-metadata";
import { StudentFinanceController, StudentFinanceService } from "./student-finance.js";
import { MonthlyController, MonthlyService } from "./monthly.js";
import { BillingController, BillingService } from "./billing.js";
export const appOptions = {
  name: "billing",
  port: 4005,
  controllers: [BillingController, MonthlyController, StudentFinanceController],
  providers: [BillingService, MonthlyService, StudentFinanceService],
  entitlement: "billing",
};
