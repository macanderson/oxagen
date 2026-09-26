// delete_toolbelt — delete a custom toolbelt no live agent carries (ADR-192,
// #4369).
//
// The row is soft-deleted, so an agent version that named the belt still
// resolves it by id. A belt a live agent carries is refused with `conflict`,
// reason `toolbelt_in_use`: move those agents to another belt first
// (`assign_agent_toolbelt`). The All tools belt is refused with `conflict`,
// reason `all_tools_is_derived`.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
import { z } from "zod";
import { registerCapability } from "../registry";
import { toolbeltIdSchema } from "./toolbelt.shared";

export const toolbeltDelete = registerCapability({
  name: "delete_toolbelt",
  domain: "toolbelt",
  description:
    "Delete a custom toolbelt that no live agent carries. The All tools belt cannot be deleted.",
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
    })
    .strict(),
  output: z
    .object({
      toolbeltId: toolbeltIdSchema,
      deleted: z.literal(true),
    })
    .strict(),
});
