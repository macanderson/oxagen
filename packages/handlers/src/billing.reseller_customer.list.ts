import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerList } from "@oxagen/oxagen/contracts/billing.reseller_customer.list";
import { listResellerCustomers } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerListHandler: CapabilityHandler<
  typeof resellerCustomerList
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const customers = await listResellerCustomers(rc, { status: input.status });
  return { customers };
};
