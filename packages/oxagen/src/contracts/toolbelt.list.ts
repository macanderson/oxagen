// list_toolbelts — the workspace's toolbelts: its All tools belt first, then
// the belts cloned from it (ADR-192, #4369).
//
// The first toolbelt path to touch a workspace creates its All tools belt, so
// this read can insert that one row. It writes nothing else.
//
// `availableTools` is the count the register form reads: when it is zero the
// workspace has imported no tool an agent could be shown, and the form's
// toolbelt step completes itself, says why, and links to the page that imports
// MCP servers.
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28): `noBillingGate: true`, `mutates: false`.
import { z } from "zod";
import { registerCapability } from "../registry";
import { toolbeltRefSchema } from "./toolbelt.shared";

const instant = z.string().datetime({ offset: true });

export const toolbeltListItem = toolbeltRefSchema
  .extend({
    description: z.string().nullable(),
    /** The belt this one was cloned from; null on the All tools belt. */
    clonedFrom: toolbeltRefSchema.nullable(),
    /** Available tools the belt holds, active or not. */
    tools: z.number().int().nonnegative(),
    /** The ones among them the belt shows an agent. */
    activeTools: z.number().int().nonnegative(),
    /** Servers the belt holds a tool from; declared and built-in tools count as one. */
    servers: z.number().int().nonnegative(),
    /** Live agents carrying the belt now. */
    agents: z.number().int().nonnegative(),
    updatedAt: instant,
  })
  .strict();
export type ToolbeltListItem = z.output<typeof toolbeltListItem>;

export const toolbeltList = registerCapability({
  name: "list_toolbelts",
  domain: "toolbelt",
  description:
    "List the workspace's toolbelts, its All tools belt first, with each belt's tool, active tool, server and agent counts, and how many tools the workspace has made available.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  // `app`: the Toolbelts tab on Tools and the register form's toolbelt step.
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      items: z.array(toolbeltListItem).max(500),
      /** Tools an owner or admin made available in this workspace, across every server. */
      availableTools: z.number().int().nonnegative(),
    })
    .strict(),
});
