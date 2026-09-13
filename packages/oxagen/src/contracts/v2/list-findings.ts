import { z } from "zod";
import { defineTool } from "./_define";
import { telemetryErrorCluster } from "../telemetry.error.cluster";

/**
 * Appendix E: `list_findings` — "ranked optimizations". Absorbs
 * `list_error_clusters`.
 *
 * §12.8 defines the findings job as the reconciler's sibling: it runs after
 * each seal, writes `cost.findings` rows, and each row carries the frames that
 * prove it and the money at stake. §14 makes it the first thing on the Spend
 * page — "Findings ranked by the money at stake."
 *
 * Why `list_error_clusters` is the source. A finding and an error cluster are
 * the same machine: bounded aggregation over recent activity, grouped by a
 * stable fingerprint, ranked, truncated, with a window echoed back so the
 * reader knows what they are looking at. Everything structural carries. What
 * does not carry is the subject — an error class becomes a costed, actionable
 * problem — so the fields that describe an error are replaced by the fields
 * §12.8 requires: kind, level, money at stake, and the frames that prove it.
 *
 * The ranking key changes with the subject, and that is the substantive
 * decision here: clusters ranked by occurrence count, findings rank by
 * `estimatedSavingMicros`. An operator does not act on the most frequent
 * problem, they act on the most expensive one.
 */

const cluster = telemetryErrorCluster.output.shape.clusters.element;

/**
 * The nine findings in §12.8's table, one literal each. An enum rather than a
 * free string because each kind has a fixed detection rule and a fixed remedy,
 * and the Spend page routes "act on a finding" (§14) off this value.
 */
const findingKind = z.enum([
  "cache_miss_after_prefix_change",
  "cache_write_never_read",
  "tool_list_bloat",
  "context_bloat",
  "retry_storm",
  "duplicate_tool_calls",
  "unproductive_tail",
  "wrong_tier",
  "budget_headroom",
]);

/**
 * §12.8: "Each finding names the level it applies to (run, agent, operator,
 * workspace)." Narrower than get_spend's rollup levels on purpose — a finding
 * about a single turn is not something anyone can act on, and an org-wide
 * finding has no owner.
 */
const findingLevel = z.enum(["run", "agent", "operator", "workspace"]);

export const listFindings = defineTool({
  name: "list_findings",
  domain: "cost",
  description:
    "List the open cost findings for the scope — specific, costed problems an operator can act on (cache misses after a prefix change, cache writes never read, tool-list bloat, context bloat, retry storms, duplicate tool calls, unproductive tails, wrong tier, budget headroom) ranked by the money at stake, each with the frames that prove it (§12.8).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,

  absorbs: ["list_error_clusters"],
  drops: [
    {
      field: "errorClass",
      from: "list_error_clusters",
      why: "an error constructor name classifies a failure; a finding is classified by its detection rule, so `kind` (the nine rows of §12.8's table) replaces it",
    },
    {
      field: "sampleMessage",
      from: "list_error_clusters",
      why: "§14's interaction rules: 'Every explanation is a chain of links to frames, records, and commits, not a summary.' A finding explains itself through `evidenceFrameIds`, not through a sampled string",
    },
    {
      field: "severity",
      from: "list_error_clusters",
      why: "§12.8 and §14 rank findings by the money at stake; a fatal/error/warn ladder would be a second, contradictory ordering. Severity survives on audit events (A.9), where it belongs",
    },
    {
      field: "source",
      from: "list_error_clusters",
      why: "which server runtime captured an error is a property of the ClickHouse error_events table, which A.10 removes; findings are derived from frames and name a level instead",
    },
    {
      field: "totalErrors",
      from: "list_error_clusters",
      why: "an error occurrence count is not a finding count; `total` and `totalEstimatedSavingMicros` are what the Spend page leads with (§14)",
    },
    {
      field: "distinctClusters",
      from: "list_error_clusters",
      why: "folded into `total` — a finding IS the distinct group, so the two numbers the cluster read had to keep apart are one number here",
    },
  ],

  // Single source, so nothing to reconcile: sensitivity, effect, roles, risk
  // and approval all carry from list_error_clusters unchanged.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Carried. The source declares `mutates: false` and its handler
   * (packages/agent/src/handlers/telemetry.error.cluster.ts) is one call into
   * `clusterErrorEvents` and a map — ADR-021 §1, pure SQL and zero model calls.
   * The findings JOB writes `cost.findings` (§12.8); this read does not, and
   * the two must not be confused because they share a name.
   */
  mutates: false,

  input: z.object({
    // Carried: the 1-720 hour clamp and its "max 720 / 30 days" message exist
    // so a lookback cannot turn into an unbounded scan.
    sinceHours: telemetryErrorCluster.input.shape.sinceHours,
    // Carried: the 1-100 page bound, for the same reason.
    limit: telemetryErrorCluster.input.shape.limit,

    // New, from §12.8: a finding names a level, so the reader filters by it.
    level: findingLevel.optional(),
    kind: findingKind.optional(),
    /**
     * The run, agent, operator or workspace the findings are about. Without it
     * the response is every open finding in the scope, which is what the Spend
     * page asks for.
     */
    scopeId: z.string().optional(),
    /**
     * Suppress findings below a money threshold. §12.4 uses one cent as the
     * variance floor; the same instinct applies here — a finding worth a
     * fraction of a cent is noise on a page that ranks by dollars.
     */
    minSavingMicros: z.number().int().nonnegative().optional(),
  }),

  output: z.object({
    findings: z
      .array(
        z.object({
          // Carried: the stable grouping key. A finding that recurs across
          // seals must be the same row, for the same reason an error class was.
          fingerprint: cluster.shape.fingerprint,

          kind: findingKind,
          level: findingLevel,
          /** The run, agent, operator or workspace id this applies to. */
          scopeId: z.string(),

          /**
           * §12.8: "the estimated saving in micro-USD from the frames it
           * cites". Integer micro-USD per §12.3 — every amount is an integer,
           * and rounding to cents happens once, at the statement line.
           */
          estimatedSavingMicros: z.number().int().nonnegative(),

          /**
           * §12.8: "Each row carries the frames that prove it." This is the
           * chain §14 requires in place of a summary, and it is what makes a
           * finding auditable rather than an opinion.
           */
          evidenceFrameIds: z.array(z.string()).min(1),

          // Carried: occurrences and the first/last bounds within the window.
          // A finding firing once is a different conversation from one firing
          // on every run, and the dates are how an operator ties it to a change.
          count: cluster.shape.count,
          firstSeen: cluster.shape.firstSeen,
          lastSeen: cluster.shape.lastSeen,
        }),
      )
      .describe("Open findings ranked by estimated saving, highest first"),

    /** Distinct open findings in the window (may exceed `findings.length`). */
    total: z.number().int().nonnegative(),
    /** What the whole page is worth — the number §14 leads the Spend page with. */
    totalEstimatedSavingMicros: z.number().int().nonnegative(),

    // Carried: truncation is explicit rather than inferred from a full page.
    truncated: telemetryErrorCluster.output.shape.truncated,
    // Carried: the effective window, so a defaulted lookback is never guessed at.
    window: telemetryErrorCluster.output.shape.window,
  }),
});

export type ListFindingsInput = z.output<typeof listFindings.input>;
export type ListFindingsOutput = z.output<typeof listFindings.output>;
