import { createWorkerService } from "@palladium/service-kit/worker";
import { appOptions } from "./app.js";
import { CommunicationWorker } from "./communication-worker.js";

export default createWorkerService({
  ...appOptions,
  scheduled: async (app) => { await app.get(CommunicationWorker).tick(); },
});
