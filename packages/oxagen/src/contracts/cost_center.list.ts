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
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: z
    .object({
      /** By label, case-insensitively. */
      costCenters: z.array(costCenterSchema),
    })
    .strict(),
});

export type CostCenterListOutput = z.output<typeof costCenterList.output>;
