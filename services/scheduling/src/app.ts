import "reflect-metadata";
import { ClassLedgerController } from "./class-ledger.js";
import { SessionsController, SessionsService } from "./sessions.js";
import {
  ExternalSessionsController,
  ExternalSessionsService,
} from "./external-sessions.js";
import {PortalSessionsController,PortalSessionsService} from './portal-sessions.js';
import {StudentAliasConsumer} from './student-scope.js';
export const appOptions = {
  name: "scheduling",
  port: 4003,
  entitlement: "scheduling",
  controllers: [
    SessionsController,
    ExternalSessionsController,
    ClassLedgerController,
    PortalSessionsController,
  ],
  providers: [SessionsService, ExternalSessionsService,PortalSessionsService,StudentAliasConsumer],
};
