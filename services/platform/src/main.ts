import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import { AuthController } from "./auth.controller.js";
import {
  BusinessesController,
  ContextController,
} from "./businesses.controller.js";
import { IdentityService } from "./identity.service.js";

await bootstrap({
  name: "platform",
  port: 4001,
  controllers: [AuthController, BusinessesController, ContextController],
  providers: [IdentityService],
  migrationsDir: fileURLToPath(new URL("../migrations/", import.meta.url)),
});
