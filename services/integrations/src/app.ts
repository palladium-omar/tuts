import "reflect-metadata";
import {
  ConnectionsController,
  ConnectionsService,
  FormHooksController,
} from "./connections.js";
import {PortalBookingController,PortalBookingService} from './portal-booking.js';
export const appOptions = {
  name: "integrations",
  port: 4008,
  entitlement: "integrations",
  controllers: [ConnectionsController, FormHooksController,PortalBookingController],
  providers: [ConnectionsService,PortalBookingService],
};
