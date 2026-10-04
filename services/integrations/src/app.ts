import "reflect-metadata";
import {
  ConnectionsController,
  ConnectionsService,
  FormHooksController,
} from "./connections.js";
export const appOptions = {
  name: "integrations",
  port: 4008,
  entitlement: "integrations",
  controllers: [ConnectionsController, FormHooksController],
  providers: [ConnectionsService],
};
