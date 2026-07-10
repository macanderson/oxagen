import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerCreate } from "@oxagen/oxagen/contracts/billing.reseller_customer.create";
import { createResellerCustomer } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerCreateHandler: CapabilityHandler<
  typeof resellerCustomerCreate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const customer = await createResellerCustomer(rc, {
    name: input.name,
    externalRef: input.externalRef ?? null,
    pricePlanId: input.pricePlanId ?? null,
  });
  return { customer };
};
