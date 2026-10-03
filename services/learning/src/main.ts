import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { bootstrap } from "@palladium/service-kit";
import {
  AssignmentsController,
  LearningService,
  ResourcesController,
} from "./learning.js";
void bootstrap({
  name: "learning",
  port: 4004,
  entitlement: "learning",
  controllers: [AssignmentsController, ResourcesController],
  providers: [LearningService],
  migrationsDir: fileURLToPath(new URL("../migrations", import.meta.url)),
});
