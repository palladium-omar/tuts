import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import { ClientsController } from "./clients.controller.js";
import { ImportsController } from "./imports.controller.js";
import { FieldsController } from "./fields.controller.js";
import { RecipientsController } from "./recipients.controller.js";
import { SourceIntake } from "./source-intake.js";

await bootstrap({
  name: "clients",
  port: 4002,
  controllers: [
    ClientsController,
    ImportsController,
    FieldsController,
    RecipientsController,
  ],
  providers: [SourceIntake],
  entitlement: "clients",
  migrationsDir: fileURLToPath(new URL("../migrations/", import.meta.url)),
});
