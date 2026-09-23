/**
 * `set_cost_center`: charge this workspace, or one agent in it, back to a
 * cost-center label, or clear it (ADR-142). The label must be live on the
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
    /** `workspace` sets the active workspace's label; `agent` sets one agent's. */
    target: z.enum(["workspace", "agent"]),
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
    "Charge this workspace, or one of its agents, back to a cost-center label from the organization's list, or clear the label. An agent's label wins over its workspace's.",
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
  input: costCenterSetInputObject.refine(
    (v) => v.target === "workspace" || v.agent !== undefined,
    { message: "an agent target names the agent's slug", path: ["agent"] },
  ),
  output: z
    .object({
      target: z.enum(["workspace", "agent"]),
      /** The workspace's public id, or the agent's. */
      id: z.string(),
      costCenter: costCenterLabelSchema.nullable(),
    })
    .strict(),
});
