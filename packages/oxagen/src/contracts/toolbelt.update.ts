// update_toolbelt — rename a custom toolbelt and edit its tools (ADR-192,
// #4369).
//
// Each change applies in order, in one transaction:
//
// - `remove_server` deletes every row the belt holds from that server.
// - `add_server` adds every available tool from that server the belt does not
//   hold yet, active or not as `active` says.
// - `set_server_active` turns every tool the belt holds from that server on or
//   off in the belt.
// - `set_tool_active` turns one tool on or off in the belt, adding it when the
//   belt does not hold it.
//
// A server is `null` for the workspace's declared and built-in tools. The All
// tools belt is derived from the workspace's tool settings and refuses every
// edit with `conflict`, reason `all_tools_is_derived`; change a tool's
// availability or default with `set_tool_state`. A tool an owner or admin has
// not made available is refused with `conflict`, reason `tool_unavailable`.
//
// An agent carrying the belt sees the change on its next turn or bundle
// fetch. The belt narrows what an agent can reach and never widens a grant.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  toolIdSchema,
  toolServerIdSchema,
  toolbeltIdSchema,
  toolbeltRefSchema,
} from "./toolbelt.shared";

export const toolbeltChangeSchema = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("remove_server"), serverId: toolServerIdSchema })
    .strict(),
  z
    .object({
      op: z.literal("add_server"),
      serverId: toolServerIdSchema,
      active: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_server_active"),
      serverId: toolServerIdSchema,
      active: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("set_tool_active"),
      toolId: toolIdSchema,
      active: z.boolean(),
    })
    .strict(),
]);
export type ToolbeltChange = z.output<typeof toolbeltChangeSchema>;

export const toolbeltUpdate = registerCapability({
  name: "update_toolbelt",
  domain: "toolbelt",
  description:
    "Rename a custom toolbelt and edit its tools: remove or add a server, or turn a server or a single tool on or off in the belt. The All tools belt cannot be edited.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "tools" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      toolbeltId: toolbeltIdSchema,
      name: z.string().trim().min(1).max(128).optional(),
      description: z.string().trim().max(1024).nullable().optional(),
      changes: z.array(toolbeltChangeSchema).max(200).default([]),
    })
    .strict(),
  output: z
    .object({
      toolbelt: toolbeltRefSchema,
    })
    .strict(),
});
