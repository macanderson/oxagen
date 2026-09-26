// set_tool_state — an owner or admin decides which tools are available to
// toolbelts and which start active (ADR-192, #4369).
//
// - `available` is `agent.tools.enabled`. A tool that is not available is out
//   of every belt, the All tools belt included, until it is made available
//   again. A belt keeps its row for the tool, so the tool comes back as the
//   belt left it.
// - `defaultActive` is `agent.tools.default_active`: whether the tool is
//   active in the All tools belt and in a clone made from it afterwards. It
//   does not change a belt that already holds the tool.
//
// Target a list of tools, or every tool one server contributed (`serverId`,
// null for the declared and built-in tools). Neither changes a grant: roles,
// mandates and kill switches still decide each call.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, or the workspace Owner.
import { z } from "zod";
import { registerCapability } from "../registry";
import { toolIdSchema, toolServerIdSchema } from "./toolbelt.shared";

export const toolStateSet = registerCapability({
  name: "set_tool_state",
  domain: "tool",
  description:
    "Make tools available to toolbelts or take them out of every belt, and set whether each starts active in the All tools belt. Target a list of tools or every tool from one server.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "tools" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      toolIds: z.array(toolIdSchema).min(1).max(200).optional(),
      /** Every tool this server contributed; null for declared and built-in tools. */
      serverId: toolServerIdSchema.optional(),
      available: z.boolean().optional(),
      defaultActive: z.boolean().optional(),
    })
    .strict()
    .refine((v) => (v.toolIds === undefined) !== (v.serverId === undefined), {
      message: "name either toolIds or serverId",
    })
    .refine((v) => v.available !== undefined || v.defaultActive !== undefined, {
      message: "set available, defaultActive or both",
    }),
  output: z
    .object({
      /** Tool rows whose state changed. */
      updated: z.number().int().nonnegative(),
    })
    .strict(),
});
