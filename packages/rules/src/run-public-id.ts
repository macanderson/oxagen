/**
 * The public id of the run a call belongs to, for an approval row's
 * `run_public_id` column (#3286, #3478).
 *
 * Both writers in this package call it: the auto-approval receipt
 * (`auto-approval-path.ts`) and the mandate gate's parked approval
 * (`mandates.ts`). `list_approvals` filters on the column, and
 * `resolve_approval` reads it to refuse the run that raised an approval
 * (ADR-175), so a writer that records no run leaves both blind.
 *
 * The kernel hands the gate the internal id (`agent_runs.id`). It is read back
 * to its public id (`arun_…`) inside the caller's org and workspace. Null when
 * no run is in scope, when the id does not resolve to a run there, and when it
 * is not a uuid at all: a context can carry a placeholder such as the
 * toolbelt read's `"toolbelt-read"`, and comparing that to the uuid column
 * makes Postgres refuse the cast and abort the writer's transaction. A
 * fabricated or stale id is never written as if it named a real run.
 * `packages/agent/src/runtime/approval.ts` reads the same way for the agent
 * runtime's writers.
 */
import { schema, type Tx } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveRunPublicId(
  tx: Tx,
  args: { orgId: string; workspaceId: string; runId: string | null },
): Promise<string | null> {
  if (!args.runId || !UUID.test(args.runId)) return null;
  const [row] = await tx
    .select({ publicId: schema.agentRuns.publicId })
    .from(schema.agentRuns)
    .where(
      and(
        eq(schema.agentRuns.id, args.runId),
        eq(schema.agentRuns.orgId, args.orgId),
        eq(schema.agentRuns.workspaceId, args.workspaceId),
      ),
    )
    .limit(1);
  return row?.publicId ?? null;
}
