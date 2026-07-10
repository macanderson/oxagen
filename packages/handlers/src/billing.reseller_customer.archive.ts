import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerArchive } from "@oxagen/oxagen/contracts/billing.reseller_customer.archive";
import { archiveResellerCustomer } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerArchiveHandler: CapabilityHandler<
  typeof resellerCustomerArchive
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  return archiveResellerCustomer(rc, { id: input.id });
};
