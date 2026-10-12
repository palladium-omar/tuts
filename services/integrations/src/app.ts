import "reflect-metadata";
import {
  ConnectionsController,
  ConnectionsService,
  FormHooksController,
} from "./connections.js";
import {PortalBookingController,PortalBookingService} from './portal-booking.js';
import {GoogleCalendarController,GoogleCalendarService} from './google-calendar.js';
export const appOptions = {
  name: "integrations",
  port: 4008,
  entitlement: "integrations",
  controllers: [GoogleCalendarController, ConnectionsController, FormHooksController,PortalBookingController],
  providers: [GoogleCalendarService,ConnectionsService,PortalBookingService],
};
