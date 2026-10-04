import { createWorkerService } from "@palladium/service-kit/worker";
import { appOptions } from "./app.js";
import { ConnectionsService } from "./connections.js";

export default createWorkerService({
  ...appOptions,
  scheduled: async (app) => { await app.get(ConnectionsService).poll(); },
});
