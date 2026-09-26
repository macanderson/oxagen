// get_toolbelt — one toolbelt, its tools grouped by the server they came from
// (ADR-192, #4369).
//
// Every server in the workspace appears once. A group the belt holds no tool
// from reads `included: false`, so a clone's editor can add it back. On the
// All tools belt every group with an imported tool is included (a server
// whose tools were never imported holds nothing), a tool an owner or admin
// has not made available reads `available: false`, and `active` is the
// tool's workspace default.
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28): `noBillingGate: true`, `mutates: false`.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  toolIdSchema,
  toolServerIdSchema,
  toolbeltIdSchema,
  toolbeltRefSchema,
} from "./toolbelt.shared";

const instant = z.string().datetime({ offset: true });

export const toolbeltToolSchema = z
  .object({
    id: toolIdSchema,
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable(),
    /** An owner or admin made the tool available to toolbelts. */
    available: z.boolean(),
    /** The tool's workspace default: active in the All tools belt and in a new clone. */
    defaultActive: z.boolean(),
    /** Whether this belt shows the tool to an agent. Always false when unavailable. */
    active: z.boolean(),
    /** Whether this belt holds the tool at all. Always true on the All tools belt. */
    member: z.boolean(),
  })
  .strict();
export type ToolbeltTool = z.output<typeof toolbeltToolSchema>;

export const toolbeltGroupSchema = z
  .object({
    server: z
      .object({
        id: toolServerIdSchema,
        /** The MCP server's name, or "Declared tools" for the null group. */
        name: z.string().min(1),
      })
      .strict(),
    /** The belt holds at least one tool from this server. */
    included: z.boolean(),
    tools: z.array(toolbeltToolSchema),
  })
  .strict();
export type ToolbeltGroup = z.output<typeof toolbeltGroupSchema>;

export const toolbeltGet = registerCapability({
  name: "get_toolbelt",
  domain: "toolbelt",
  description:
    "Read one toolbelt with every tool in the workspace grouped by server: whether the belt holds each server and tool, whether each tool is active in the belt, and whether an owner or admin made it available.",
  mode: "sync",
  surfaces: ["api", "mcp"],
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
  input: z
    .object({
      toolbeltId: toolbeltIdSchema,
    })
    .strict(),
  output: z
    .object({
      toolbelt: toolbeltRefSchema
        .extend({
          description: z.string().nullable(),
          clonedFrom: toolbeltRefSchema.nullable(),
          updatedAt: instant,
        })
        .strict(),
      groups: z.array(toolbeltGroupSchema),
      /** Live agents carrying the belt now. */
      agents: z
        .array(
          z
            .object({
              id: z.string().regex(/^agt_[0-9a-z]+$/),
              name: z.string().min(1),
              slug: z.string().min(1),
            })
            .strict(),
        )
        .max(500),
    })
    .strict(),
});
