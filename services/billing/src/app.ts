import "reflect-metadata";
import { MonthlyController, MonthlyService } from "./monthly.js";
import { BillingController, BillingService } from "./billing.js";
export const appOptions = {
  name: "billing",
  port: 4005,
  controllers: [BillingController, MonthlyController],
  providers: [BillingService, MonthlyService],
  entitlement: "billing",
};
