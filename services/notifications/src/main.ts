import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import {
  NotificationConsumer,
  NotificationsController,
  NotificationsService,
} from "./notifications.js";
import {
  CampaignsController,
  CommunicationConnectionsController,
  CommunicationsService,
} from "./communications.js";
import { CommunicationWorker } from "./communication-worker.js";
void bootstrap({
  name: "notifications",
  port: 4007,
  entitlement: "notifications",
  controllers: [
    NotificationsController,
    CampaignsController,
    CommunicationConnectionsController,
  ],
  providers: [
    NotificationConsumer,
    NotificationsService,
    CommunicationsService,
    CommunicationWorker,
  ],
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});
