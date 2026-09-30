import { z } from "zod";
import { registerCapability } from "../registry";
import {
  toolEgressClassSchema,
  toolRiskGradeSchema,
  toolSideEffectClassSchema,
} from "./tool.classification";
import { studioServerNameSchema } from "./tool.studio.draft.save";

const isoDateSchema = z.string().datetime();

/** Where a tool's classification came from. */
export const studioSuggestionBasisSchema = z.enum([
  "source_hint",
  "annotations",
  "http_method",
  "graphql_operation",
  "grpc_idempotency",
  "fail_safe",
]);

/**
 * One tool on Studio's Tools tab (lane M10, #4682). An imported tool is a
 * tools.toml key, with the classification tools.toml confirms. An available
 * tool is one the server offers that no key imports yet, with the
 * classification Studio suggests.
 */
export const studioServerToolSchema = z.object({
  /** The upstream name, as the source offers it. */
  name: z.string(),
  /** The tools.toml key, or null for an available tool. */
  key: z.string().nullable(),
  state: z.enum(["imported", "available"]),
  /** The upstream description. */
  description: z.string().nullable(),
  /** tools.toml's description, which replaces the upstream one, or null. */
  importedDescription: z.string().nullable(),
  inputSchema: z.record(z.unknown()),
  /** The MCP hints, or null when the source gives none. */
  annotations: z.record(z.unknown()).nullable(),
  /**
   * The definition's tokens. An imported tool's count is the compiled
   * definition's, and null when the folder does not compile. An available
   * tool's count is an estimate that leaves out the title and the output
   * schema.
   */
  tokens: z.number().int().min(0).nullable(),
  classification: z.object({
    risk: toolRiskGradeSchema,
    sideEffect: toolSideEffectClassSchema,
    egress: toolEgressClassSchema,
    impacts: z.array(z.string()),
    /** True for an imported tool: tools.toml states it. False for a suggestion. */
    confirmed: z.boolean(),
    /** The signal a suggestion came from, or null for an imported tool. */
    basis: studioSuggestionBasisSchema.nullable(),
  }),
  /**
   * The mcp.tool_snapshots row this tool reads from. Null for an imported
   * tool before the first discovery, or after the source drops it.
   */
  snapshotId: z.string().nullable(),
  capturedAt: isoDateSchema.nullable(),
  /** True while the gateway hides the tool until the sync steering PR merges. */
  withheld: z.boolean(),
});

export type StudioServerTool = z.output<typeof studioServerToolSchema>;

/** One server folder's tools, as list_studio_tools answers them. */
export const studioToolsListOutputSchema = z.object({
  server: z.string(),
  /** `mcs_…`, or null before the server has a registry row. */
  mcpServerId: z.string().nullable(),
  /** The newest snapshot row among the offered tools, or null with none. */
  snapshotId: z.string().nullable(),
  capturedAt: isoDateSchema.nullable(),
  /** server.toml's exposure: every definition direct, or three search tools. */
  exposure: z.object({
    mode: z.enum(["direct", "search"]),
    /** server.toml's definition_budget, or the default. */
    budget: z.number().int().min(1),
  }),
  tokens: z.object({
    /** Every imported tool's definition together, or null when the folder does not compile. */
    definitions: z.number().int().min(0).nullable(),
    budget: z.number().int().min(1),
  }),
  /** tools.toml's key count. */
  imported: z.number().int().min(0),
  /** The count of tools the last discovery found. */
  offered: z.number().int().min(0),
  /** True when a direct server's definitions exceed its budget. */
  searchRecommended: z.boolean(),
  /** The compiler's message when the folder does not compile, or null. */
  compileError: z.string().nullable(),
  tools: z.array(studioServerToolSchema),
});

/**
 * List one server's tools for Studio's Tools tab (lane M10, #4682): every
 * tools.toml key first, then every tool the last discovery found that no key
 * imports. Each row carries its classification, its definition tokens, and
 * whether the gateway withholds it. The totals compare the imported tools'
 * definition tokens with the server's definition budget.
 *
 * `get_studio_draft` returns only the edits Studio staged, and
 * `list_agent_tools` returns the tools an agent may call. Neither reads the
 * published folder beside the discovered tools.
 */
export const toolStudioToolsList = registerCapability({
  name: "list_studio_tools",
  domain: "tool",
  description:
    "List one server folder's tools: each tools.toml key with its confirmed classification, then each tool the last discovery found that no key imports, with a suggested classification. Includes each tool's definition tokens and the server's token budget.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: studioToolsListOutputSchema,
});

export type ToolStudioToolsListInput = z.output<typeof toolStudioToolsList.input>;
export type ToolStudioToolsListOutput = z.output<typeof toolStudioToolsList.output>;
