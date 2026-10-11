import { createWorkerService } from "@palladium/service-kit/worker";
import { appOptions } from "./app.js";
import { CommunicationWorker } from "./communication-worker.js";

import {runNotificationTicks} from "./tick-budget.js";
import {ReminderWorker} from "./reminder-worker.js";

export default createWorkerService({
  ...appOptions,
  scheduled: async (app) => { await runNotificationTicks(app.get(CommunicationWorker), app.get(ReminderWorker)); },
});
