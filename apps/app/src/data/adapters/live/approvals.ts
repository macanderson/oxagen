// The live approvals adapter (plan §5 Batch 3, lane A2: approvals).
//
// Reads run inside the viewer's tenant scope: runInTenantScope sets the scope,
// withTenantDb opens the transaction with the RLS GUCs, and every query also
// filters on org and workspace. No capability reads the approvals table today
// (the only contract is the write `resolve_approval`), so there is no contract
// layer to go through; promote a read contract when one lands. The command
// delivery report is `list_commands` (packages/handlers/src/tacho.command.list.ts).
//
// The column-level mapping, and why a real approval row does not yet fit the
// view model, is in ./mappers/approvals.ts.
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ApprovalItem } from "@/data/contracts";
import { notBacked, readError, readOk } from "@/data/not-backed";
import type { ApprovalReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { isOrgOnlyScope } from "@/server/tenant-scope";
import {
  type ApprovalRequestRow,
  RECENTLY_EXPIRED_MS,
  toApprovalCandidate,
  UNRECORDED_APPROVAL_PATHS,
} from "./mappers/approvals";

/** The most approvals one queue read returns, soonest expiry first. */
export const QUEUE_LIMIT = 100;

/** The rows the adapter reads. The database implementation is below; tests pass a fake. */
export type ApprovalStore = {
  /**
   * Unresolved approvals expiring after `since`, plus approvals resolved as
   * expired after it, with the workspace's slug (null when there are no rows,
   * or the workspace is not visible under the scope).
   */
  openApprovals(
    scope: Scope,
    since: Date,
  ): Promise<{ workspaceSlug: string | null; rows: ApprovalRequestRow[] }>;
};

const ar = schema.approvalRequests;

export const dbApprovalStore: ApprovalStore = {
  openApprovals: (scope, since) =>
    runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const rows = await tx
          .select()
          .from(ar)
          .where(
            and(
              eq(ar.orgId, scope.orgId),
              eq(ar.workspaceId, scope.workspaceId),
              or(
                and(isNull(ar.resolution), gt(ar.expiresAt, since)),
                and(eq(ar.resolution, "expired"), gt(ar.resolvedAt, since)),
              ),
            ),
          )
          .orderBy(asc(ar.expiresAt))
          .limit(QUEUE_LIMIT);
        if (rows.length === 0) return { workspaceSlug: null, rows };
        const [ws] = await tx
          .select({ slug: schema.workspaces.slug })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.id, scope.workspaceId),
              eq(schema.workspaces.orgId, scope.orgId),
            ),
          )
          .limit(1);
        return { workspaceSlug: ws?.slug ?? null, rows };
      }),
    ),
};

/** A view-model mismatch on a path the store does record: a mapping bug, never "not backed". */
export class ApprovalContractMismatch extends Error {
  readonly code = "approval_contract_mismatch";
  constructor(readonly paths: readonly string[]) {
    super(`approval row does not fit ApprovalItem at: ${paths.join(", ")}`);
    this.name = "ApprovalContractMismatch";
  }
}

const unrecorded = new Set<string>(UNRECORDED_APPROVAL_PATHS);
const ApprovalList = z.array(ApprovalItem);
const workspaceRequired = () => readError("workspace_required", 400);

export function createLiveApprovals(
  store: ApprovalStore,
  clock: () => Date = () => new Date(),
): ApprovalReadPort {
  return {
    async pending(scope, q) {
      // Approvals are workspace rows; an organization page has no queue to read.
      if (isOrgOnlyScope(scope)) return workspaceRequired();
      const now = clock();
      const { workspaceSlug, rows } = await store.openApprovals(
        scope,
        new Date(now.getTime() - RECENTLY_EXPIRED_MS),
      );
      // Nothing open is a recorded fact, for the workspace and for any run in it.
      if (rows.length === 0) return readOk(ApprovalList.parse([]));
      if (workspaceSlug === null) return readError("workspace_not_found", 404);

      const runId = q?.runId;
      const items: ApprovalItem[] = [];
      for (const row of rows) {
        const candidate = toApprovalCandidate(row, { workspaceSlug, now });
        const parsed = ApprovalItem.safeParse(candidate);
        if (!parsed.success) {
          const paths = parsed.error.issues.map((i) => i.path.join("."));
          const mismatched = paths.filter((p) => !unrecorded.has(p));
          if (mismatched.length > 0)
            throw new ApprovalContractMismatch(mismatched);
        }
        // A run filter cannot place an approval whose run id is not recorded.
        // Filtering it out would report a false "nothing waiting" for the run
        // while the call is parked, so the read is not backed. This check reads
        // the candidate with `== null` so it holds before and after `runId`
        // becomes nullable in the contract.
        if (runId !== undefined && candidate.runId == null)
          return notBacked("M2", "G1");
        // Open approvals exist but their chain is not recorded: say so,
        // never an empty queue that hides a parked call.
        if (!parsed.success) return notBacked("M2", "G1");
        items.push(parsed.data);
      }
      return readOk(
        runId === undefined ? items : items.filter((i) => i.runId === runId),
      );
    },
  };
}

export const liveApprovals: ApprovalReadPort =
  createLiveApprovals(dbApprovalStore);
