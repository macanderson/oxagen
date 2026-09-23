/**
 * `set_cost_center`: charge a workspace, or one agent in the active workspace,
 * back to a cost-center label, or clear it (ADR-142). A workspace target names
 * the workspace by public id, so an org Owner, Admin or Billing member who is
 * not in it, or an org-level key, can still label it; without the id it is the
 * active workspace. The label must be live on the
 * organization's list. The rollup reads the agent's label first, then the
 * workspace's, when it next rolls a run up; runs already rolled up keep the
 * cost center they had. Org Owner, Admin or Billing, checked in the handler.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { costCenterLabelSchema } from "./cost_center.shared";

/**
 * The base object of the input, exported because the registered `input` is
 * refined and has no `.shape`; the MCP tool builds its parameters from this
 * and `invoke()` re-parses the refined input on every surface.
 */
export const costCenterSetInputObject = z
  .object({
    /** `workspace` sets a workspace's label; `agent` sets one agent's. */
    target: z.enum(["workspace", "agent"]),
    /** The workspace's public id when `target` is `workspace`; the active workspace when absent. */
    workspaceId: z
      .string()
      .startsWith("wrk_")
      .optional()
      .describe("Public workspace id (wrk_…)"),
    /** The agent's slug in this workspace; required when `target` is `agent`. */
    agent: z.string().min(1).optional(),
    /** The label, or null to clear it. */
    costCenter: costCenterLabelSchema.nullable(),
  })
  .strict();

export const costCenterSet = registerCapability({
  name: "set_cost_center",
  domain: "spend",
  description:
    "Charge a workspace, named by its public id or else the active one, or one agent in the active workspace, back to a cost-center label from the organization's list, or clear the label. An agent's label wins over its workspace's.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: costCenterSetInputObject
    .refine((v) => v.target === "workspace" || v.agent !== undefined, {
      message: "an agent target names the agent's slug",
      path: ["agent"],
    })
    .refine((v) => v.target === "workspace" || v.workspaceId === undefined, {
      message: "an agent target is in the active workspace",
      path: ["workspaceId"],
    }),
  output: z
    .object({
      target: z.enum(["workspace", "agent"]),
      /** The workspace's public id, or the agent's. */
      id: z.string(),
      costCenter: costCenterLabelSchema.nullable(),
    })
    .strict(),
});
