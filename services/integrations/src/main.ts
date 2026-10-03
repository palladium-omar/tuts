import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import {
  ConnectionsController,
  ConnectionsService,
  FormHooksController,
} from "./connections.js";
void bootstrap({
  name: "integrations",
  port: 4008,
  entitlement: "integrations",
  controllers: [ConnectionsController, FormHooksController],
  providers: [ConnectionsService],
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});
