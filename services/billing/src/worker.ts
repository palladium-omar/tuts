import { createWorkerService } from "@palladium/service-kit/worker";
import { appOptions } from "./app.js";
import { MonthlyService } from "./monthly.js";

export default createWorkerService({
  ...appOptions,
  scheduled: async (app) => { await app.get(MonthlyService).runAutomatic(); },
});
