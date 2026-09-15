// proof.ts — the reads of the witness record that more than one package makes
// (ADR-064): a run's verdict, aggregated from its `evidence.verdicts` rows, and
// the worker run a witness run was for. Both take the caller's executor, so a
// tenant-scoped handler and the system-scoped cost rollup share one query, and
// both name the organisation and workspace beside RLS.
import { aggregateRunVerdict, type ProofVerdict } from "@oxagen/run-evidence";
import { and, asc, eq } from "drizzle-orm";
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
