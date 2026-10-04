import "reflect-metadata";
import {
  AssignmentsController,
  LearningService,
  ResourcesController,
} from "./learning.js";
export const appOptions = {
  name: "learning",
  port: 4004,
  entitlement: "learning",
  controllers: [AssignmentsController, ResourcesController],
  providers: [LearningService],
};
