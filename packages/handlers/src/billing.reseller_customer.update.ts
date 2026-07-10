import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerUpdate } from "@oxagen/oxagen/contracts/billing.reseller_customer.update";
import { updateResellerCustomer } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerUpdateHandler: CapabilityHandler<
  typeof resellerCustomerUpdate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const customer = await updateResellerCustomer(rc, input);
  return { customer };
};
