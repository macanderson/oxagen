import type { CapabilityContext } from "../types.js";
import type {
  BillingSubscriptionReadInput,
  BillingSubscriptionReadOutput,
} from "./billing.subscription.read.js";

export async function billingSubscriptionReadHandler(
  _input: BillingSubscriptionReadInput,
  _ctx: CapabilityContext,
): Promise<BillingSubscriptionReadOutput> {
  throw new Error("not implemented");
}
