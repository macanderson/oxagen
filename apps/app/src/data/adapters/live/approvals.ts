// The live approvals adapter (plan §5 Batch 3, lane A2: approvals + commands).
//
// Reads run inside the viewer's tenant scope: runInTenantScope sets the scope,
// withTenantDb opens the transaction with the RLS GUCs, and every query also
// filters on org and workspace. No capability reads either table today (the
// only contracts are the writes `resolve_approval` and `dispatch_tacho_command`,
// and the host-only `fetch_tacho_commands`), so there is no contract layer to
// go through; promote a read contract when one lands.
//
// The column-level mapping, and why a real approval row does not yet fit the
// view model, is in ./mappers/approvals.ts.
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { ApprovalItem, PublicId } from "@/data/contracts";
import { notBacked, type Read, readError, readOk } from "@/data/not-backed";
import type { ApprovalReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { isOrgOnlyScope } from "@/server/tenant-scope";
import {
  type ApprovalRequestRow,
  CommandDelivery,
  type ControlCommandRow,
  RECENTLY_EXPIRED_MS,
  toApprovalCandidate,
  toCommandDelivery,
  UNRECORDED_APPROVAL_PATHS,
} from "./mappers/approvals";

/** The most approvals one queue read returns, soonest expiry first. */
export const QUEUE_LIMIT = 100;
/** The most command ids one delivery read accepts. */
export const COMMAND_IDS_LIMIT = 100;

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
  /** The workspace's control commands with these public ids. */
  commands(scope: Scope, ids: readonly string[]): Promise<ControlCommandRow[]>;
};

const ar = schema.approvalRequests;
const cc = schema.tachoControlCommands;

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
  commands: (scope, ids) =>
    runInTenantScope(scope, () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(cc)
          .where(
            and(
              eq(cc.orgId, scope.orgId),
              eq(cc.workspaceId, scope.workspaceId),
              inArray(cc.publicId, [...ids]),
            ),
          )
          .orderBy(asc(cc.issuedAt))
          .limit(COMMAND_IDS_LIMIT),
      ),
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
const CommandDeliveryList = z.array(CommandDelivery);
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

      const items: ApprovalItem[] = [];
      for (const row of rows) {
        const parsed = ApprovalItem.safeParse(
          toApprovalCandidate(row, { workspaceSlug, now }),
        );
        if (!parsed.success) {
          const paths = parsed.error.issues.map((i) => i.path.join("."));
          const mismatched = paths.filter((p) => !unrecorded.has(p));
          if (mismatched.length > 0)
            throw new ApprovalContractMismatch(mismatched);
          // Open approvals exist but their chain is not recorded: say so,
          // never an empty queue that hides a parked call.
          return notBacked("M2", "G1");
        }
        items.push(parsed.data);
      }
      const runId = q?.runId;
      return readOk(
        runId === undefined ? items : items.filter((i) => i.runId === runId),
      );
    },
  };
}

/**
 * Delivery reports for commands the viewer dispatched (`dispatch_tacho_command`
 * returns their ids). Not on a port yet: promote to the approvals/commands port.
 */
export function createLiveCommandDeliveries(
  store: ApprovalStore,
  clock: () => Date = () => new Date(),
) {
  return async (
    scope: Scope,
    commandIds: readonly string[],
  ): Promise<Read<CommandDelivery[]>> => {
    if (isOrgOnlyScope(scope)) return workspaceRequired();
    if (commandIds.length === 0) return readOk(CommandDeliveryList.parse([]));
    if (
      commandIds.length > COMMAND_IDS_LIMIT ||
      !commandIds.every((id) => PublicId.safeParse(id).success)
    )
      return readError("invalid_command_ids", 400);
    const now = clock();
    const rows = await store.commands(scope, commandIds);
    return readOk(
      CommandDeliveryList.parse(rows.map((r) => toCommandDelivery(r, now))),
    );
  };
}

export const liveApprovals: ApprovalReadPort =
  createLiveApprovals(dbApprovalStore);

export const liveCommandDeliveries =
  createLiveCommandDeliveries(dbApprovalStore);
