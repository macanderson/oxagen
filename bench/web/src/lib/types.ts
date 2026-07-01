/**
 * Shared types for the Oxagen SWE-bench dashboard.
 *
 * The dashboard shows exactly two kinds of numbers: results loaded from a real
 * `oxagen.eval.v1` JSON file produced by our harness (MEASURED, or SAMPLE if the
 * file is explicitly flagged as illustrative), and citations to dated
 * third-party sources (REFERENCE, see `sources.ts`). There is no simulator and
 * no invented score anywhere in this package — see `README.md`.
 */

/** Per-task metrics attached to a run summary or an individual result. */
export interface EvalMetrics {
  readonly cost_usd: number;
  readonly tokens: number;
  readonly wall_s: number;
}

/** One task attempt within an eval run (one row of `results`). */
export interface EvalResult {
  readonly task_id: string;
  /** 0 or 1 — whether the task's hidden tests passed after the agent's patch. */
  readonly passed: 0 | 1;
  readonly reward: number;
  readonly metrics: EvalMetrics;
  readonly labels: Readonly<Record<string, string>>;
  readonly task_group: string;
  readonly repeat_idx: number;
}

/** Run-level metadata — one row of the results table maps to one of these. */
export interface EvalRunMeta {
  readonly run_id: string;
  readonly run_group: string;
  readonly agent_name: string;
  readonly agent_version: string;
  readonly model: string;
  readonly harness: string;
  readonly suite: string;
  readonly suite_version: string;
  readonly git_sha: string;
  readonly git_branch: string;
  readonly environment: string;
  readonly graph_code: number;
  readonly graph_exec: number;
  readonly graph_mem: number;
  readonly warm: number;
  readonly history_depth: number;
  readonly seed: number;
  readonly n_tasks: number;
  readonly n_passed: number;
  readonly resolved_rate: number;
  readonly metrics: EvalMetrics;
  readonly labels: Readonly<Record<string, string>>;
  readonly notes: string;
}

/** The full `oxagen.eval.v1` document shape emitted by our harness. */
export interface EvalRun {
  readonly schema: "oxagen.eval.v1";
  readonly run: EvalRunMeta;
  readonly results: readonly EvalResult[];
}

/**
 * Where a number on screen came from. `measured` runs must always carry enough
 * to reproduce them; `reference` cites a dated external publication; `sample`
 * carries no numeric claim about Oxagen or anyone else and must render with an
 * unmistakable warning treatment.
 */
export type Provenance =
  | {
      readonly kind: "measured";
      readonly harness: string;
      readonly dataset: string;
      readonly model: string;
      readonly runDate: string;
      readonly gitSha: string;
      readonly reproduce: string;
    }
  | {
      readonly kind: "reference";
      readonly source: string;
      readonly url: string;
      readonly published: string;
    }
  | {
      readonly kind: "sample";
    };

/** One row of the results table — a single run's aggregate outcome. */
export interface AgentSummaryRow {
  readonly runId: string;
  readonly agentName: string;
  readonly model: string;
  readonly dataset: string;
  readonly resolvedRate: number;
  readonly nPassed: number;
  readonly nTasks: number;
  readonly avgCostUsd: number | null;
  readonly avgTokens: number | null;
  readonly avgWallS: number | null;
  readonly provenance: Provenance;
  /**
   * Non-null when >=2 rows share the same dataset + model — an apples-to-apples
   * "controlled head-to-head" group, per the fairness rules in `methodology`.
   */
  readonly controlledGroupKey: string | null;
}

/** A cited external source rendered in the Sources bibliography. */
export interface SourceRef {
  readonly title: string;
  readonly url: string;
  readonly kind: "paper" | "leaderboard" | "tool";
  readonly published?: string;
  readonly description: string;
}
