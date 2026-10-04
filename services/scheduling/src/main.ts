import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import { ClassLedgerController } from "./class-ledger.js";
import { SessionsController, SessionsService } from "./sessions.js";
import {
  ExternalSessionsController,
  ExternalSessionsService,
} from "./external-sessions.js";
void bootstrap({
  name: "scheduling",
  port: 4003,
  entitlement: "scheduling",
  controllers: [
    SessionsController,
    ExternalSessionsController,
    ClassLedgerController,
  ],
  providers: [SessionsService, ExternalSessionsService],
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});
