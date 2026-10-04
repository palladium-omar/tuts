import "reflect-metadata";
import { AuthController } from "./auth.controller.js";
import {
  BusinessesController,
  ContextController,
} from "./businesses.controller.js";
import { IdentityService } from "./identity.service.js";

export const appOptions = {
  name: "platform",
  port: 4001,
  controllers: [AuthController, BusinessesController, ContextController],
  providers: [IdentityService],
};
