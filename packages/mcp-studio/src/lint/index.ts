// lint: the tool checks Studio runs on a server folder (lane M5;
// mcp-studio-spec, Tool checks).
//
// An error blocks the steering PR. A warning and an info show in the PR and
// in Studio and block nothing. Each finding names the tool and field at
// fault and the change that clears it.
//
// lint reads the folder and what the source offers now. It never calls
// compile, which throws at the first folder that cannot build: lint reports
// every finding at once, on a draft Studio has not saved as well as on a
// steering PR.
import type { McpToolsLock } from "../contract/lock";
import type { RegistryEntry } from "../contract/registry-entry";
import type { McpServer, ServerSourceType } from "../contract/server";
import type { McpTools } from "../contract/tools";
import type { ImportNote } from "../model/import-result";
import type { UpstreamTool } from "../model/upstream-tool";
import { lintRegistry } from "./registry";
import type { Report } from "./report";
import { lintServer } from "./server";
import { lintTools } from "./tools";

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

  // Registry.
  /** An entry with no remote, and no source.machines to run its package. */
  registry_without_remote: { level: "info", sources: ["registry"] },
  /** No source.registry_type, no package of that type, an mcpb bundle, a transport other than stdio, or another runner in runtimeHint. */
  package_cannot_run: { level: "error", sources: ["registry"] },
  /** A required argument with no value, a positional argument with no unique valueHint, or a source.arguments key no argument takes. */
  argument_without_value: { level: "error", sources: ["registry"] },
  /** A ${NAME} not in source.env, or a variable the package requires missing from it. */
  env_variable_missing: { level: "error", sources: ["registry"] },
  /** A secret argument with a literal value, or one only the entry fills. */
  secret_literal: { level: "error", sources: ["registry"] },
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
  /**
   * The catalog entry at source.version, for a registry source. The package
   * checks need it. Without it, lint checks only what server.toml says.
   */
  registry_entry?: RegistryEntry;
}

export interface LintContext {
  /** The organization's credential references, for unknown_credential. */
  credentials: ReadonlySet<string>;
  /** Tool keys whose irreversible suggestion a person accepted unchanged. */
  accepted_unchanged: ReadonlySet<string>;
}

const LEVEL_ORDER: readonly FindingLevel[] = ["error", "warning", "info"];

/**
 * Every finding for one server folder: errors, then warnings, then infos.
 * Within a level, server findings come first, then each tool in tools.toml's
 * order, each in the Tool checks table's order, then the definition budget.
 */
export function lint(folder: ServerFolder, context: LintContext): Finding[] {
  const type = folder.server.source.type;
  const found: Finding[] = [];
  const report: Report = (rule, at) => {
    const { level, sources } = LINT_RULES[rule];
    if (sources !== "all" && !(sources as readonly ServerSourceType[]).includes(type)) return;
    found.push({ rule, level, ...at });
  };
  lintServer(folder, context, report);
  lintRegistry(folder, report);
  lintTools(folder, context, report);
  return LEVEL_ORDER.flatMap((level) => found.filter((finding) => finding.level === level));
}
