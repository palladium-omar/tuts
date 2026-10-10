import "reflect-metadata";
import { GroupsController } from "./groups.controller.js";
import { PortalStudentsController } from "./portal-students.controller.js";
import { IdentityController } from "./identity.controller.js";
import { PortalInternalController } from "./portal-internal.controller.js";
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
    IdentityController,
    GroupsController,
    PortalStudentsController,
    PortalInternalController,
    ImportsController,
    FieldsController,
    RecipientsController,
  ],
  providers: [SourceIntake],
  entitlement: "clients",
};
