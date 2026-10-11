import "reflect-metadata";
import {
  NotificationConsumer,
  NotificationsController,
  NotificationsService,
} from "./notifications.js";
import {
  CampaignsController,
  CommunicationConnectionsController,
  CommunicationsService,
} from "./communications.js";
import { CommunicationWorker } from "./communication-worker.js";
import { AuthMailController, AuthMailService } from "./auth-mail.js";
import {StudentRemindersController, StudentRemindersService} from "./student-reminders.js";
import {ReminderWorker} from "./reminder-worker.js";
export const appOptions = {
  name: "notifications",
  port: 4007,
  entitlement: "notifications",
  controllers: [
    NotificationsController,
    CampaignsController,
    CommunicationConnectionsController,
    AuthMailController,
    StudentRemindersController,
  ],
  providers: [
    NotificationConsumer,
    NotificationsService,
    CommunicationsService,
    CommunicationWorker,
    AuthMailService,
    StudentRemindersService,
    ReminderWorker,
  ],
};
