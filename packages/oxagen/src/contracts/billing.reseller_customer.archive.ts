import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * archive_reseller_customer — soft-delete an end-customer account. The row is
 * retained (deleted_at stamped) so historical re-bill runs keep a resolvable
 * customer name; the account simply drops out of lists and future pushes.
 */
export const resellerCustomerArchive = registerCapability({
  name: "archive_reseller_customer",
  domain: "billing",
  description:
    "Archive (soft-delete) a reseller end-customer account. Historical re-bill runs are preserved; the account no longer appears in lists or pushes.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ id: z.string(), archived: z.literal(true) }),
});

export type ResellerCustomerArchiveInput = z.output<
  typeof resellerCustomerArchive.input
>;
export type ResellerCustomerArchiveOutput = z.output<
  typeof resellerCustomerArchive.output
>;
