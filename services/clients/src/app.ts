import "reflect-metadata";
import { ClientsController } from "./clients.controller.js";
import { ImportsController } from "./imports.controller.js";
import { FieldsController } from "./fields.controller.js";
import { RecipientsController } from "./recipients.controller.js";
import { SourceIntake } from "./source-intake.js";

export const appOptions = {
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
};
