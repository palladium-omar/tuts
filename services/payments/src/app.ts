import "reflect-metadata";
import { PaymentsController, PaymentsService } from "./payments.js";
import { StripeClient } from "./stripe-provider.js";
import { StripeCheckoutsService } from "./stripe-checkouts.js";
import { ReconciliationTransactionsController, ReconciliationTransactionsService } from './reconciliation-transactions.js';
export const appOptions = {
  name: "payments",
  port: 4006,
  controllers: [PaymentsController, ReconciliationTransactionsController],
  providers: [PaymentsService, StripeClient, StripeCheckoutsService, ReconciliationTransactionsService],
  entitlement: "payments",
};
