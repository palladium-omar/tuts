import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import { MonthlyController, MonthlyService } from "./monthly.js";
import { BillingController, BillingService } from "./billing.js";
bootstrap({
  name: "billing",
  port: 4005,
  controllers: [BillingController, MonthlyController],
  providers: [BillingService, MonthlyService],
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
  entitlement: "billing",
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
