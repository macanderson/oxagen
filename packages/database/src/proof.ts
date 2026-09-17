// proof.ts — the reads of the witness record that more than one package makes
// (ADR-064): a run's verdict, aggregated from its `evidence.verdicts` rows, and
// the worker run a witness run was for. Both take the caller's executor, so a
// tenant-scoped handler and the system-scoped cost rollup share one query, and
// both name the organisation and workspace beside RLS.
import { aggregateRunVerdict, type ProofVerdict } from "@oxagen/run-evidence";
import { and, asc, eq, sql, type Column, type SQL } from "drizzle-orm";
import { verdicts } from "./schema/run-evidence-foundation";
import type { Tx } from "./tenant";

type ProofScope = { orgId: string; workspaceId: string };

/** The run's verdict over its witnesses' latest attempts; null when none reported. */
export async function readRunVerdict(
  tx: Tx,
  scope: ProofScope,
  runId: string,
): Promise<ProofVerdict | null> {
  const rows = await tx
    .select({
      witnessId: verdicts.witnessId,
      attemptNo: verdicts.attemptNo,
      verdict: verdicts.verdict,
    })
    .from(verdicts)
    .where(
      and(
        eq(verdicts.orgId, scope.orgId),
        eq(verdicts.workspaceId, scope.workspaceId),
        eq(verdicts.runId, runId),
      ),
    );
  return aggregateRunVerdict(
    // The column's CHECK holds the closed vocabulary.
    rows.map((row) => ({ ...row, verdict: row.verdict as ProofVerdict })),
  );
}

/** The worker run a witness run reported on, by the first verdict naming it; null for any other run. */
export async function readWitnessedRunId(
  tx: Tx,
  scope: ProofScope,
  witnessRunId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ runId: verdicts.runId })
    .from(verdicts)
    .where(
      and(
        eq(verdicts.orgId, scope.orgId),
        eq(verdicts.workspaceId, scope.workspaceId),
        eq(verdicts.witnessRunId, witnessRunId),
      ),
    )
    .orderBy(asc(verdicts.observedAt))
    .limit(1);
  return rows[0]?.runId ?? null;
}

/**
 * Whether this caller must be shown no witness run at all (ADR-064): every
 * API-key caller. A worker holds the API key, and a run a verdict names as its
 * witness run is the run that checked the worker's own work — showing it to
 * the worker shows it its witness.
 */
export function hidesWitnessRuns(ctx: { apiKeyId: string | null }): boolean {
  return ctx.apiKeyId !== null;
}

/**
 * The one definition of "no verdict in this workspace names this run as its
 * witness run". Every read that can return runs to a caller who may hold an
 * API key must AND this in when `hidesWitnessRuns(ctx)`.
 *
 * It lives here, next to the other witness reads, rather than in either
 * caller: `list_runs` is in `@oxagen/handlers` and `search_tools` is in
 * `@oxagen/agent`, and handlers depends on agent, so neither can import the
 * other. Each also builds its own query over a different table (`agent_runs`
 * for the ledger, `tacho_sessions` for Tacho), so the shared thing has to be
 * the predicate rather than the query. `search_tools` shipped without it and
 * returned by a second path exactly the runs `list_runs` hides — which is why
 * this is one exported function and not a line copied into each reader.
 */
export function notWitnessRun(run: {
  orgId: Column;
  workspaceId: Column;
  publicId: Column;
}): SQL {
  return sql`not exists (select 1 from ${verdicts} where ${verdicts.orgId} = ${run.orgId} and ${verdicts.workspaceId} = ${run.workspaceId} and ${verdicts.witnessRunId} = ${run.publicId}::text)`;
}
