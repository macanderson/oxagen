// get_agent_toolbelt — the belt an agent would be shown, computed and not
// executed (MC spec §6.6; #2956). The read behind the Agents detail page's
// toolbelt tab: the tool list with the decision the pipeline produced per
// tool, the rule that decided it, how the belt was computed, what the model
// receives, and what the agent cannot see.
//
// The decision per tool is the runtime's own: the handler runs the same
// per-tool decision `materializeTools` runs before it builds a tool
// (packages/agent/src/runtime/toolbelt.ts), against the same resolver, the
// same entitlement read and the same kill-switch rows, with the caller as
// the initiating human of the delegation ceiling (agent ∩ human). A tool
// outside the belt is in `cannotSee` with the rule that excluded it.
//
// `noBillingGate: true`, `mutates: false`: a console read (INV-28).
import { z } from "zod";
import { registerCapability } from "../registry";

/** Spec §6.6: full belt up to this many tools, searchable above it. */
export const FULL_BELT_LIMIT = 40;

export const beltDecisionSchema = z.enum(["allow", "require_approval"]);

/**
 * Which gate decided. `agent:<rule>` and `human:<rule>` name the resolver
 * trace step that decided that side of the ceiling (e.g. `agent:7:role_grant`,
 * `human:8:default`); the others are the gates around the resolver.
 */
export const beltRuleSchema = z.string().min(1);

export const beltToolSchema = z
  .object({
    /** A capability name, or `<server>__<tool>` for an MCP tool. */
    name: z.string().min(1),
    kind: z.enum(["capability", "mcp"]),
    /** The MCP server's public id (`mcp_…`); null for a capability. */
    server: z.string().nullable(),
    category: z.string().nullable(),
    riskLevel: z.enum(["low", "medium", "high"]),
    decision: beltDecisionSchema,
    rule: beltRuleSchema,
    /** True when the tool only reads and may run beside other calls. */
    readOnly: z.boolean(),
  })
  .strict();

export const beltExclusionSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["capability", "mcp"]),
    server: z.string().nullable(),
    rule: beltRuleSchema,
  })
  .strict();

export const agentToolbeltGet = registerCapability({
  name: "get_agent_toolbelt",
  domain: "agent",
  description:
    "Compute the toolbelt an agent would be shown without executing anything: the decision and rule per tool, how the belt was computed, what the model receives in full or searchable mode, and what the agent cannot see.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** Agent public id (`agt_…`) or slug. */
      agentId: z.string().min(1).max(128),
      /** Force a presentation; omitted, the belt size against the limit decides. */
      mode: z.enum(["full", "searchable"]).optional(),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      agentKey: z.string().nullable(),
      computedAt: z.string().datetime({ offset: true }),
      /** How the belt was computed. */
      basis: z
        .object({
          /** `caller`: the delegation ceiling used the calling user's principal; `sentinel`: no human principal resolved, the ceiling is the unprivileged sentinel. */
          humanCeiling: z.enum(["caller", "sentinel"]),
          /** Role-grant rows in the two principals' roles. */
          roleGrants: z.number().int().nonnegative(),
          /** The deny-generation counters the belt was computed under. */
          denyGeneration: z
            .object({
              org: z.number().int().nonnegative(),
              workspace: z.number().int().nonnegative(),
            })
            .strict(),
          /** Active emergency denies in scope. */
          killSwitches: z.number().int().nonnegative(),
        })
        .strict(),
      presentation: z
        .object({
          mode: z.enum(["full", "searchable"]),
          limit: z.number().int().positive(),
          /** `definitions`: every tool definition is in the request; `meta_tools`: the request carries the search and load meta-tools. */
          sentToModel: z.enum(["definitions", "meta_tools"]),
        })
        .strict(),
      tools: z.array(beltToolSchema),
      cannotSee: z.array(beltExclusionSchema),
    })
    .strict(),
});

export type AgentToolbeltGetInput = z.output<typeof agentToolbeltGet.input>;
export type AgentToolbeltGetOutput = z.output<typeof agentToolbeltGet.output>;
export type BeltTool = z.output<typeof beltToolSchema>;
export type BeltExclusion = z.output<typeof beltExclusionSchema>;
