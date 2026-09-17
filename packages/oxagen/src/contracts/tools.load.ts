/**
 * `load_tools`: the belt definitions meta-tool (MC spec App. E, §6.6). The
 * full definition — name, description, input JSON Schema, the governance
 * facts the model plans by — of capabilities named from `search_tools`.
 * Only a capability the in-app agent may call is returned; a name outside
 * that set is reported back as unknown and describes nothing, which is the
 * §6.6 guarantee that what the model cannot call it cannot be shown.
 *
 * Inside a turn the engine-facing twin adds the loaded tools to what the
 * next completion is shown; this contract is the same read for a caller
 * outside a turn (the API, the MCP, a client building a belt view).
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { SEARCH_ROW_LIMIT } from "./tools.search";

export const toolDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    /** JSON Schema of the capability's input, as the model is shown it. */
    inputSchema: z.record(z.unknown()),
    riskLevel: z.enum(["low", "medium", "high"]),
    requiresApproval: z.boolean(),
    readOnly: z.boolean(),
  })
  .strict();

export const toolsLoad = registerCapability({
  name: "load_tools",
  domain: "tools",
  description:
    "Return the full definitions of capabilities the in-app agent may call, by name: description, input schema and the governance facts a caller plans by. A name outside that set is reported as unknown.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  input: z
    .object({
      names: z.array(z.string().min(1).max(128)).min(1).max(SEARCH_ROW_LIMIT),
    })
    .strict(),
  output: z
    .object({
      tools: z.array(toolDefinitionSchema).max(SEARCH_ROW_LIMIT),
      /** Names the belt does not hold. */
      unknown: z.array(z.string()).max(SEARCH_ROW_LIMIT),
    })
    .strict(),
});

export type ToolsLoadInput = z.output<typeof toolsLoad.input>;
export type ToolsLoadOutput = z.output<typeof toolsLoad.output>;
