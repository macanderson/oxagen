/**
 * The mandate compiled onto the wire: an agent's tool RBAC and external-tool
 * rules mapped onto the harness's own permission shape (allow/deny/ask), and
 * its budget mapped onto `budget.mode`.
 *
 * Two rule kinds feed the mapping, both already real and already enforced
 * somewhere in this codebase:
 *
 * - **Tool RBAC**: `resourceScope.mcp` rules from `packages/iam`
 *   (`collectResourceScope`, `EffectiveMcpScope`), first-match-wins
 *   "server:tool" glob rules a role or grant attaches to the agent's own IAM
 *   principal, evaluated today at the in-app agent's MCP tool-call gate
 *   (`packages/agent/src/runtime/mcp-rbac.ts`).
 * - **External-tool rules**: the workspace's decision rules
 *   (`packages/rules`), the same set `materialize-tools.ts`'s
 *   `externalDecisionCheck` enforces for an external capability call. Only
 *   the rules that already name an MCP server:tool call are translatable
 *   here. See `decisionRuleToHarnessRule` below for exactly which, and why
 *   the rest cannot be.
 *
 * Both compile to the SAME shape (`HarnessRule`) before the one pure function
 * that matters, `mapMandateToBundlePermissions`, buckets them into
 * `permissions.{allow,deny,ask}`. That function never reads a database and
 * never reads the clock; every caller resolves its inputs first.
 */
import type { PolicyBundle } from "@oxagen/tacho";
import {
  agentVersionBudget,
  agentVersionContainment,
} from "@oxagen/oxagen/agent-version-config";

/** The harness's own three-value permission vocabulary (mcp-config, tacho's rule evaluator). */
export type HarnessRuleEffect = "allow" | "deny" | "ask";

export interface HarnessRule {
  /** A tacho permission-rule string, e.g. `mcp__github__create_issue` or `mcp__github`. */
  rule: string;
  effect: HarnessRuleEffect;
}

/** Tool RBAC input: one `resourceScope.mcp` rule (`packages/iam`'s `McpRule`). */
export interface McpRbacRuleInput {
  /** A "server:tool" glob, e.g. `github:*` or `github:delete_*`. */
  pattern: string;
  effect: HarnessRuleEffect;
}

/** External-tool input: one workspace decision rule (`packages/rules`'s `DecisionRule`). */
export interface ExternalToolRuleInput {
  capability: string;
  effect: "allow" | "deny" | "require_approval";
}

/**
 * A "server:tool" glob (tool RBAC's own pattern shape) as a tacho permission
 * rule string. `mcp__server__tool` matches exactly the way Claude Code and
 * Cursor name their own MCP tools, so a rule authored once, in the RBAC
 * pattern's own syntax, reaches the wrapped harness's tool-call gate without
 * translation loss.
 *
 * A bare `*` tool segment becomes an explicit `__*` suffix rather than the
 * bare-server form (`mcp__server`, no trailing `__`) so a server segment that
 * is itself a glob still composes correctly. The bare form's exact-server
 * fast path in tacho's own matcher only fires for a literal server name.
 */
export function mcpRuleToHarnessRule(rule: McpRbacRuleInput): HarnessRule {
  const colon = rule.pattern.indexOf(":");
  const server = colon === -1 ? rule.pattern : rule.pattern.slice(0, colon);
  const tool = colon === -1 ? "*" : rule.pattern.slice(colon + 1);
  return { rule: `mcp__${server}__${tool}`, effect: rule.effect };
}

/**
 * A decision rule as a tacho permission rule, or `undefined` when it is not
 * translatable.
 *
 * Only a rule whose capability is the literal wildcard `*` or the MCP-wide
 * `mcp.*` can cross into the harness's own tool syntax. A per-server decision
 * rule is authored as `mcp.<serverId>.<tool>` (the synthetic capability id
 * `mcp-rbac.ts` documents), naming an Oxagen MCP-server ROW ID: an internal
 * identifier the wrapped harness never sees and the mandate has no way to
 * resolve to the server NAME Claude Code or Cursor knows it by. Mapping that
 * id onto `mcp__<name>__*` would either guess a name or require a join this
 * function, deliberately pure, cannot perform. Such a rule keeps governing
 * the in-app agent's own MCP calls at `mcp-rbac.ts`; it is not silently
 * dropped from enforcement, only from this second, harness-facing surface.
 */
export function decisionRuleToHarnessRule(
  rule: ExternalToolRuleInput,
): HarnessRule | undefined {
  if (rule.capability !== "*" && rule.capability !== "mcp.*") return undefined;
  const effect: HarnessRuleEffect =
    rule.effect === "require_approval" ? "ask" : rule.effect;
  return { rule: "mcp__*", effect };
}

/**
 * The one pure mapping: a flat, ordered list of harness rules to the bundle's
 * `permissions` shape. Order within a bucket is preserved (tacho's own
 * evaluator is first-match-wins per bucket); which bucket wins for a given
 * call is the evaluator's own fixed deny-then-ask-then-allow precedence
 * (`packages/tacho/src/host/bundle.ts`, Claude Code's own order), unaffected
 * by the order rules were appended here. So a `github:*` allow beside a
 * `github:merge_pull_request` ask still asks for the merge.
 *
 * An empty input produces empty arrays: the safe default this replaces, not
 * an invented one. A mandate with nothing to say permits nothing extra and
 * forbids nothing extra, exactly as today.
 */
export function mapMandateToBundlePermissions(input: {
  mcpRules: readonly McpRbacRuleInput[];
  externalToolRules: readonly ExternalToolRuleInput[];
}): PolicyBundle["permissions"] {
  const rules: HarnessRule[] = [
    ...input.mcpRules.map(mcpRuleToHarnessRule),
    ...input.externalToolRules
      .map(decisionRuleToHarnessRule)
      .filter((r): r is HarnessRule => r !== undefined),
  ];
  const permissions: PolicyBundle["permissions"] = {
    allow: [],
    deny: [],
    ask: [],
  };
  for (const { rule, effect } of rules) permissions[effect].push(rule);
  return permissions;
}

/**
 * The `budget` table an agent's active version config carries (ADR-192).
 * `perRunMicros` is this mandate's session budget (one tacho host
 * session is one run of the wrapped harness). `perDayMicros` is the agent's
 * ceiling for one UTC day (ADR-160), signed only to a host that enforces it:
 * see `deriveBundleBudget`.
 */
export interface AgentBudgetDoc {
  perRunMicros?: number;
  perDayMicros?: number;
}

/**
 * The active version's budget, read from its config. The agent definition
 * file that once owned these ceilings is gone (ADR-192); the migration that
 * removed it copied each file's `[budget]` table into `config`.
 */
export function budgetDocFromVersion(version: {
  config: unknown;
}): AgentBudgetDoc | undefined {
  return agentVersionBudget(version.config);
}

/** The active version's containment requirement (ADR-152), read from its config. */
export function containmentFromVersion(version: {
  config: unknown;
}): { required: true } | undefined {
  return agentVersionContainment(version.config);
}

function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

/**
 * `budget.mode` is `"enforced"` only when the agent's active version
 * declares a ceiling the host will enforce; otherwise `"observed"`, with no
 * limit fields at all. No default limit is invented for a mandate that named
 * none: that would be a ceiling nobody set, enforced anyway.
 *
 * `per_day_micros` is signed as `daily_limit_usd` only when `enforcesDaily`
 * says the host advertised `BUNDLE_FEATURE_DAILY_BUDGET` (ADR-160). An older
 * host parses the field and refuses nothing against it, so signing it there
 * would deliver a ceiling that holds nowhere and, for a mandate carrying only
 * that ceiling, read `"enforced"` while enforcing nothing (#3728).
 */
export function deriveBundleBudget(
  doc: AgentBudgetDoc | undefined,
  options: { enforcesDaily?: boolean } = {},
): PolicyBundle["budget"] {
  const sessionUsd =
    doc?.perRunMicros !== undefined && doc.perRunMicros > 0
      ? microsToUsd(doc.perRunMicros)
      : undefined;
  const dailyUsd =
    options.enforcesDaily === true &&
    doc?.perDayMicros !== undefined &&
    doc.perDayMicros > 0
      ? microsToUsd(doc.perDayMicros)
      : undefined;
  if (sessionUsd === undefined && dailyUsd === undefined)
    return { mode: "observed" };
  return {
    mode: "enforced",
    ...(sessionUsd !== undefined ? { session_limit_usd: sessionUsd } : {}),
    ...(dailyUsd !== undefined ? { daily_limit_usd: dailyUsd } : {}),
  };
}
