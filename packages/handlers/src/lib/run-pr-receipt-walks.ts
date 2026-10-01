// The reads and writes behind `cost.run_pr_receipt_walks` (#4511): where the
// hourly outcome refresh stands in each ledger run's pull request receipts.
// The refresh (./run-pr-outcomes-refresh.ts) runs inside the workspace's
// tenant scope, so these go through `withTenantDb`.
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

/** The scope one refresh pass visits. */
type Scope = { orgId: string; workspaceId: string };

/** One `provider_publish.pull_request_opened` receipt, as the walk keeps it. */
export interface LedgerReceipt {
  repositoryId: string;
  number: number;
  headSha: string | null;
}

/** Why the refresh wrote no rows for a ledger run on its last try. */
export type UnresolvedReason =
  | "run_not_found"
  | "repository_not_connected"
  | "read_failed";

/** Where the refresh stands in one ledger run's receipts. */
export interface ReceiptWalk {
  runId: string;
  /** The `run_seq` of the last event read; null before the first page. */
  afterSeq: string | null;
  /** True once the walk read the run's last event. */
  complete: boolean;
  receipts: LedgerReceipt[];
  attemptedAt: Date;
  unresolved: UnresolvedReason | null;
  /** When the refresh tries an unresolved run again; null while nothing stands in the way. */
  retryAfter: Date | null;
}

const walks = schema.runPrReceiptWalks;

/**
 * A walk row's receipts. The column is written only by this module, so an
 * entry of another shape is dropped, not trusted.
 */
function receiptsOf(value: unknown): LedgerReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LedgerReceipt[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { repositoryId, number, headSha } = entry as Record<string, unknown>;
    if (
      typeof repositoryId !== "string" ||
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number <= 0
    )
      return [];
    return [
      {
        repositoryId,
        number,
        headSha: typeof headSha === "string" ? headSha : null,
      },
    ];
  });
}

function unresolvedOf(value: string | null): UnresolvedReason | null {
  return value === "run_not_found" ||
    value === "repository_not_connected" ||
    value === "read_failed"
    ? value
    : null;
}

/** The stored walks of the given ledger runs. */
export async function readReceiptWalks(
  scope: Scope,
  runIds: readonly string[],
): Promise<ReceiptWalk[]> {
  if (runIds.length === 0) return [];
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(walks)
      .where(
        and(
          eq(walks.orgId, scope.orgId),
          eq(walks.workspaceId, scope.workspaceId),
          inArray(walks.runId, [...runIds]),
        ),
      ),
  );
  return rows.map((r) => {
    const unresolved = unresolvedOf(r.unresolved);
    return {
      runId: r.runId,
      afterSeq: r.afterSeq,
      complete: r.complete,
      receipts: receiptsOf(r.receipts),
      attemptedAt: r.attemptedAt,
      unresolved,
      retryAfter: unresolved === null ? null : r.retryAfter,
    };
  });
}

/**
 * Write each walk, one upsert per run, then delete the workspace's walks
 * created more than 31 days ago. A walk is created after its run started, so
 * every walk deleted belongs to a run that left the 30-day outcome window.
 */
export async function saveReceiptWalks(
  scope: Scope,
  list: readonly ReceiptWalk[],
): Promise<void> {
  await withTenantDb(async (tx) => {
    for (const walk of list) {
      const values = {
        afterSeq: walk.afterSeq,
        complete: walk.complete,
        receipts: walk.receipts,
        attemptedAt: walk.attemptedAt,
        unresolved: walk.unresolved,
        retryAfter: walk.unresolved === null ? null : walk.retryAfter,
      };
      await tx
        .insert(walks)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          runId: walk.runId,
          ...values,
        })
        .onConflictDoUpdate({
          target: [walks.orgId, walks.workspaceId, walks.runId],
          set: { ...values, updatedAt: sql`now()` },
        });
    }
    await tx
      .delete(walks)
      .where(
        and(
          eq(walks.orgId, scope.orgId),
          eq(walks.workspaceId, scope.workspaceId),
          lt(walks.createdAt, sql`now() - interval '31 days'`),
        ),
      );
  });
}
