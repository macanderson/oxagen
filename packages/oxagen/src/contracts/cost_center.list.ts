/**
 * `list_cost_centers`: the organization's live cost-center labels, with how
 * many agents and workspaces name each (ADR-142). Organization-level
 * (`scoped: false`): the list is one per organization and every workspace
 * charges back against it. Soft-deleted labels are left out.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { costCenterSchema } from "./cost_center.shared";

export const costCenterList = registerCapability({
  name: "list_cost_centers",
  domain: "spend",
  description:
    "List this organization's cost-center labels, the labels spend is charged back to, with how many agents and workspaces name each.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  // Every member of the organization may read the labels, and the handler
  // checks no role. The workspace grant says so for a workspace Member, which
  // the agent surface requires a contract to state
  // (tools/scripts/check-role-enforcement.mjs rule 2).
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Member: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  input: z.object({}).strict(),
  output: z
    .object({
      /** By label, case-insensitively. */
      costCenters: z.array(costCenterSchema),
    })
    .strict(),
});

export type CostCenterListOutput = z.output<typeof costCenterList.output>;
