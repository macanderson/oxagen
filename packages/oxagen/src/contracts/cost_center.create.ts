/**
 * `create_cost_center`: add a label to the organization's cost-center list
 * (ADR-142). Adding a label the organization deleted restores that row, so a
 * label names one row across its history; adding a live label again is a
 * conflict. Org Owner, Admin or Billing, checked in the handler.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { costCenterLabelSchema, costCenterSchema } from "./cost_center.shared";

export const costCenterCreate = registerCapability({
  name: "create_cost_center",
  domain: "spend",
  description:
    "Add a cost-center label to this organization's list, so agents and workspaces can be charged back to it. Restores a label that was deleted.",
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
  input: z
    .object({
      label: costCenterLabelSchema,
      description: z.string().trim().min(1).max(280).optional(),
    })
    .strict(),
  output: z.object({ costCenter: costCenterSchema }).strict(),
});
