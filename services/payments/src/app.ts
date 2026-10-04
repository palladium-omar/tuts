import "reflect-metadata";
import { PaymentsController, PaymentsService } from "./payments.js";
import { StripeClient } from "./stripe-provider.js";
import { StripeCheckoutsService } from "./stripe-checkouts.js";
export const appOptions = {
  name: "payments",
  port: 4006,
  controllers: [PaymentsController],
  providers: [PaymentsService, StripeClient, StripeCheckoutsService],
  entitlement: "payments",
};
