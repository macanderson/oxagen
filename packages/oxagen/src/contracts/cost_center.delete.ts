/**
 * `delete_cost_center`: soft-delete a label from the organization's list
 * (ADR-142). The row stays, so past statements still name it. Every agent and
 * workspace that names it is cleared, so the rollup charges none of their new
 * runs to it, and restoring the label restores no assignment. Org Owner, Admin
 * or Billing, checked in the handler.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { costCenterLabelSchema } from "./cost_center.shared";

export const costCenterDelete = registerCapability({
  name: "delete_cost_center",
  domain: "spend",
  description:
    "Delete a cost-center label from this organization's list. Runs already rolled up keep it; new runs stop being charged to it.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({ label: costCenterLabelSchema }).strict(),
  output: z
    .object({
      label: costCenterLabelSchema,
      deletedAt: z.string(),
    })
    .strict(),
});
