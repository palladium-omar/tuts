import "reflect-metadata";
import { AuthController } from "./auth.controller.js";
import {
  BusinessesController,
  ContextController,
} from "./businesses.controller.js";
import { IdentityService } from "./identity.service.js";
import { PortalController } from "./portal.controller.js";
import { PortalService } from "./portal.service.js";

export const appOptions = {
  name: "platform",
  port: 4001,
  controllers: [AuthController, BusinessesController, ContextController, PortalController],
  providers: [IdentityService, PortalService],
};
