import "reflect-metadata";
import { PortalLearningController } from "./portal.controller.js";
import { LearningIdentity } from "./student-scope.js";
import {
  AssignmentsController,
  LearningService,
  ResourcesController,
} from "./learning.js";
export const appOptions = {
  name: "learning",
  port: 4004,
  entitlement: "learning",
  controllers: [AssignmentsController, ResourcesController,PortalLearningController],
  providers: [LearningService,LearningIdentity],
};
