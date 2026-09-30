// store.ts: Studio's draft listings in Postgres (ADR-233, #4756).
//
// mcp.studio_listings holds one row per draft. `request` pins a listing on
// the draft revision the person sees and replaces any earlier listing of the
// draft. The MCP process that holds a machine's poll claims an open listing
// for the machine's groups, asks the machine for tools/list, and then
// `complete` writes the tools into the draft and finishes the listing in one
// transaction. A claim older than CLAIM_STALE_MS is open again, so a process
// that died mid-listing does not leave the row running for good. `complete`
// and `fail` write nothing unless the row still carries the claim they hold,
// and `complete` writes the draft only at the revision the listing was asked
// on: a draft saved since then is not the draft that was pinned.
import { HandlerError } from "@oxagen/oxagen";
import type { StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { mcpLockSourceSchema, type McpLockSource } from "@oxagen/mcp-studio";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, arrayOverlaps, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { staleRevision } from "../import/store";

const listings = schema.mcpStudioListings;
const drafts = schema.mcpStudioDrafts;

/** How long a claimed listing may run before another process may claim it. */
export const CLAIM_STALE_MS = 5 * 60_000;

export interface ListingScope {
  orgId: string;
  workspaceId: string;
}

export type ListingStatus = "waiting_for_machine" | "running" | "succeeded" | "failed";

/** A listing as the store holds it. */
export interface StoredListing {
  server: string;
  status: ListingStatus;
  machineGroups: string[];
  lockSource: McpLockSource;
  draftRevision: number;
  requestedBy: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  machine: string | null;
  toolCount: number | null;
  error: string | null;
}

export interface ListingRequest {
  server: string;
  /** The draft revision the person sees. */
  draftRevision: number;
  groups: readonly string[];
  lockSource: McpLockSource;
  requestedBy: string | null;
}

/** A listing a machine's MCP process claimed. `claimedAt` is the claim it holds. */
export interface ClaimedListing {
  id: string;
  server: string;
  draftRevision: number;
  lockSource: McpLockSource;
  requestedBy: string | null;
  claimedAt: Date;
}

export interface ListingCompletion {
  /** The draft's new MCP source: the tools the machine listed and the pin. */
  source: Extract<StudioSource, { type: "mcp" }>;
  machine: string;
  toolCount: number;
}

/** What `complete` did. */
export type CompletionResult =
  | { status: "succeeded"; draftRevision: number }
  | { status: "draft_changed" }
  | { status: "claim_lost" };

export interface ListingStore {
  /**
   * Pin a listing on the draft at `draftRevision`, replacing any earlier
   * listing of the draft. Refuses with not_found when the server has no
   * draft, and with draft_revision_stale when the draft moved on.
   */
  request(scope: ListingScope, input: ListingRequest, now: Date): Promise<StoredListing>;
  get(scope: ListingScope, server: string): Promise<StoredListing | null>;
}

export interface ListingClaimStore {
  /**
   * Claim the workspace's oldest open listing for a machine in one of
   * `groups` that `owner` asked for: one waiting for a machine, or one whose
   * claim went stale. A listing starts a program before any review, so it
   * runs only on a machine its requester enrolled (ADR-233). The read locks
   * the row and skips one another transaction holds.
   */
  claimOpen(
    scope: ListingScope,
    groups: readonly string[],
    owner: string,
    now: Date,
  ): Promise<ClaimedListing | null>;
  /** Write the draft's new source and finish the listing, in one transaction. */
  complete(scope: ListingScope, claim: ClaimedListing, done: ListingCompletion, now: Date): Promise<CompletionResult>;
  /** Finish the listing as failed, if the claim still holds. */
  fail(scope: ListingScope, claim: ClaimedListing, error: string, now: Date): Promise<void>;
}

const inScope = <T>(scope: ListingScope, fn: (tx: Tx) => Promise<T>) =>
  runInTenantScope(scope, () => withTenantDb(fn));

function unreadable(server: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "listing_unreadable",
    message: `The listing for ${server} no longer matches the lock format. List its tools again.`,
  });
}

const columns = {
  server: listings.serverName,
  status: listings.status,
  machineGroups: listings.machineGroups,
  lockSource: listings.lockSource,
  draftRevision: listings.draftRevision,
  requestedBy: listings.requestedBy,
  requestedAt: listings.requestedAt,
  claimedAt: listings.claimedAt,
  finishedAt: listings.finishedAt,
  machine: listings.machine,
  toolCount: listings.toolCount,
  error: listings.error,
};

type Row = {
  server: string;
  status: string;
  machineGroups: string[];
  lockSource: unknown;
  draftRevision: number;
  requestedBy: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  machine: string | null;
  toolCount: number | null;
  error: string | null;
};

function fromRow(row: Row): StoredListing {
  const lockSource = mcpLockSourceSchema.safeParse(row.lockSource);
  if (!lockSource.success) throw unreadable(row.server);
  return { ...row, status: row.status as ListingStatus, lockSource: lockSource.data };
}

/** The live draft of `server`, locked for this transaction. */
async function liveDraft(tx: Tx, scope: ListingScope, server: string) {
  const [row] = await tx
    .select({ id: drafts.id, revision: drafts.revision })
    .from(drafts)
    .where(
      and(
        eq(drafts.orgId, scope.orgId),
        eq(drafts.workspaceId, scope.workspaceId),
        eq(drafts.serverName, server),
        isNull(drafts.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/** The claim still holds: the row is running under this claim's time. */
function holds(claim: ClaimedListing) {
  return and(
    eq(listings.id, claim.id),
    eq(listings.status, "running"),
    eq(listings.claimedAt, claim.claimedAt),
  );
}

export const postgresListingStore: ListingStore = {
  async request(scope, input, now) {
    return inScope(scope, async (tx) => {
      const draft = await liveDraft(tx, scope, input.server);
      if (draft === null) {
        throw new HandlerError({
          code: "not_found",
          reason: "draft_not_found",
          message: `No draft for ${input.server} exists. Save one with its server.toml, then list its tools.`,
        });
      }
      if (draft.revision !== input.draftRevision) {
        throw staleRevision(
          `The draft for ${input.server} is at revision ${draft.revision}, not ${input.draftRevision}. Read it again, then list its tools.`,
        );
      }
      const values = {
        status: "waiting_for_machine",
        machineGroups: [...input.groups],
        lockSource: input.lockSource,
        draftRevision: input.draftRevision,
        requestedBy: input.requestedBy,
        requestedAt: now,
        claimedAt: null,
        finishedAt: null,
        machine: null,
        toolCount: null,
        error: null,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(listings)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          draftId: draft.id,
          serverName: input.server,
          createdAt: now,
          ...values,
        })
        .onConflictDoUpdate({ target: listings.draftId, set: values })
        .returning(columns);
      return fromRow(row as Row);
    });
  },

  async get(scope, server) {
    return inScope(scope, async (tx) => {
      const [row] = await tx
        .select(columns)
        .from(listings)
        .innerJoin(drafts, eq(drafts.id, listings.draftId))
        .where(
          and(
            eq(listings.orgId, scope.orgId),
            eq(listings.workspaceId, scope.workspaceId),
            eq(listings.serverName, server),
            isNull(drafts.deletedAt),
          ),
        )
        .limit(1);
      return row === undefined ? null : fromRow(row as Row);
    });
  },
};

export const postgresListingClaimStore: ListingClaimStore = {
  async claimOpen(scope, groups, owner, now) {
    if (groups.length === 0) return null;
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
    return inScope(scope, async (tx) => {
      const [row] = await tx
        .select({
          id: listings.id,
          server: listings.serverName,
          draftRevision: listings.draftRevision,
          lockSource: listings.lockSource,
          requestedBy: listings.requestedBy,
        })
        .from(listings)
        .where(
          and(
            eq(listings.orgId, scope.orgId),
            eq(listings.workspaceId, scope.workspaceId),
            eq(listings.requestedBy, owner),
            or(
              eq(listings.status, "waiting_for_machine"),
              and(eq(listings.status, "running"), lt(listings.claimedAt, staleBefore)),
            ),
            arrayOverlaps(listings.machineGroups, [...groups]),
          ),
        )
        .orderBy(asc(listings.requestedAt), asc(listings.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (row === undefined) return null;
      const lockSource = mcpLockSourceSchema.safeParse(row.lockSource);
      if (!lockSource.success) {
        await tx
          .update(listings)
          .set({
            status: "failed",
            error: `The listing for ${row.server} no longer matches the lock format. List its tools again.`,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(listings.id, row.id));
        return null;
      }
      await tx
        .update(listings)
        .set({ status: "running", claimedAt: now, updatedAt: now })
        .where(eq(listings.id, row.id));
      return {
        id: row.id,
        server: row.server,
        draftRevision: row.draftRevision,
        lockSource: lockSource.data,
        requestedBy: row.requestedBy,
        claimedAt: now,
      };
    });
  },

  async complete(scope, claim, done, now) {
    return inScope(scope, async (tx) => {
      const [held] = await tx
        .select({ draftId: listings.draftId })
        .from(listings)
        .where(holds(claim))
        .limit(1)
        .for("update");
      if (held === undefined) return { status: "claim_lost" };
      const [draft] = await tx
        .update(drafts)
        .set({
          source: done.source,
          revision: sql`${drafts.revision} + 1`,
          updatedAt: now,
          // The machine answered the person who asked, so the save is theirs,
          // as a save from Studio would be.
          updatedById: claim.requestedBy,
        })
        .where(
          and(
            eq(drafts.id, held.draftId),
            eq(drafts.revision, claim.draftRevision),
            isNull(drafts.deletedAt),
          ),
        )
        .returning({ revision: drafts.revision });
      if (draft === undefined) {
        await tx
          .update(listings)
          .set({
            status: "failed",
            error: `The draft for ${claim.server} was saved after its tools were asked for, so the listing wrote nothing. List its tools again.`,
            machine: done.machine,
            finishedAt: now,
            updatedAt: now,
          })
          .where(eq(listings.id, claim.id));
        return { status: "draft_changed" };
      }
      await tx
        .update(listings)
        .set({
          status: "succeeded",
          machine: done.machine,
          toolCount: done.toolCount,
          error: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(listings.id, claim.id));
      return { status: "succeeded", draftRevision: draft.revision };
    });
  },

  async fail(scope, claim, error, now) {
    await inScope(scope, (tx) =>
      tx
        .update(listings)
        .set({ status: "failed", error, finishedAt: now, updatedAt: now })
        .where(holds(claim)),
    );
  },
};
