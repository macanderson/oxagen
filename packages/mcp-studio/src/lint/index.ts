// lint: the tool checks Studio runs on a server folder (lane M5;
// mcp-studio-spec, Tool checks).
//
// An error blocks the steering PR. A warning and an info show in the PR and
// in Studio and block nothing. Each finding names the tool and field at
// fault and the change that clears it.
import type { McpToolsLock } from "../contract/lock";
import type { McpServer, ServerSourceType } from "../contract/server";
import type { McpTools } from "../contract/tools";
import type { ImportNote } from "../model/import-result";
import type { UpstreamTool } from "../model/upstream-tool";
import { notBuilt } from "../not-built";

export type FindingLevel = "error" | "warning" | "info";

/** Every rule, its level, and the sources it runs on. "all" runs on every source. */
export const LINT_RULES = {
  // Every source.
  missing_classification: { level: "error", sources: "all" },
  tool_not_offered: { level: "error", sources: "all" },
  no_description: { level: "error", sources: "all" },
  /** Two tools with one name, or a full name over 64 characters. */
  invalid_name: { level: "error", sources: "all" },
  /** A credential reference that names no credential in the organization. */
  unknown_credential: { level: "error", sources: "all" },
  long_description: { level: "warning", sources: "all" },
  /** More than 20 inputs. */
  many_inputs: { level: "warning", sources: "all" },
  /** An enum with more than 50 values. */
  large_enum: { level: "warning", sources: "all" },
  /** From Large servers: the imported definitions pass definition_budget. The fix is search mode. */
  over_definition_budget: { level: "warning", sources: "all" },
  /** A person accepted an irreversible tool's suggestion without a change. */
  irreversible_suggestion_unreviewed: { level: "info", sources: "all" },

  // OpenAPI.
  no_output_schema: { level: "warning", sources: ["openapi"] },
  unbounded_array: { level: "warning", sources: ["openapi"] },
  undiscriminated_one_of: { level: "warning", sources: ["openapi"] },
  recursive_schema: { level: "info", sources: ["openapi"] },

  // OpenAPI and GraphQL.
  deprecated_imported: { level: "warning", sources: ["openapi", "graphql"] },

  // GraphQL.
  deep_selection: { level: "warning", sources: ["graphql"] },
  unpaged_list: { level: "warning", sources: ["graphql"] },

  // gRPC.
  any_field: { level: "warning", sources: ["grpc"] },
  unbounded_stream: { level: "warning", sources: ["grpc"] },
  no_idempotency_level: { level: "info", sources: ["grpc"] },

  // Local.
  local_without_machines: { level: "info", sources: ["local"] },
} as const satisfies Record<string, { level: FindingLevel; sources: "all" | readonly ServerSourceType[] }>;

export type LintRule = keyof typeof LINT_RULES;

export interface Finding {
  rule: LintRule;
  level: FindingLevel;
  /** The tools.toml key, or undefined for the server as a whole. */
  tool: string | undefined;
  /** The field at fault, such as inputSchema.properties.reason.enum. */
  field: string | undefined;
  message: string;
  /** The change that clears the finding. */
  fix: string;
}

/** One server folder, parsed, with what the source offers now. */
export interface ServerFolder {
  /** The folder name, which is the server's name. */
  name: string;
  server: McpServer;
  tools: McpTools;
  /** tools.lock.json, or undefined before the first lock. */
  lock: McpToolsLock | undefined;
  /** Every tool the source offers, imported or not. */
  offered: readonly UpstreamTool[];
  /** What import skipped, cut, or could not map. */
  notes: readonly ImportNote[];
}

export interface LintContext {
  /** The organization's credential references, for unknown_credential. */
  credentials: ReadonlySet<string>;
  /** Tool keys whose irreversible suggestion a person accepted unchanged. */
  accepted_unchanged: ReadonlySet<string>;
}

/** Every finding for one server folder, errors first. */
export function lint(folder: ServerFolder, context: LintContext): Finding[] {
  return notBuilt("lint", folder, context);
}
