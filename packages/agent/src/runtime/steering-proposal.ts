// steering-proposal.ts: connect a plugin listing's server in a workspace whose
// tools live in its steering repo (M13, #4478, ADR-209 §6).
//
// Two paths turn a plugin.installed_plugins listing into its mcp.mcp_servers
// row: set_plugin_enabled (@oxagen/handlers) and the OAuth sign-in
// (mcp-oauth-flow.ts). Once steeringWriter() returns a writer, neither may
// write an enabled legacy row. An enabled row connects the server before
// anyone reviews it, and a legacy row puts the workspace back on direct
// writes, because steeringWriter() counts it as a row the migration has yet
// to move. Both paths decide here, so they cannot drift apart.
//
// The decision reads the listing's row, deleted rows included:
//
// - held: a live row the steering repo already holds, origin steering or a
//   legacy row a migration PR named. The caller writes it directly, as it
//   would in a workspace that has not migrated.
// - pending: a live proposed row with a folder name. Its steering PR is
//   open, and the caller refuses with steering_pr_open.
// - proposed: anything else (no row, a deleted row, a legacy or proposed row
//   with no folder name). The row becomes a proposed, disabled row, and the
//   writer opens a steering PR that adds its folder. The first publish after
//   that PR merges turns the row on. When the PR does not open, the row goes
//   back to what it was and the error is rethrown.
//
// It imports only types from ./steering-pr, so a test that mocks that module
// still runs this one.
import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import type { OpenedSteeringPr, ServerFolderWriter } from "./steering-pr";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.mcp" },
});

type ServerInsert = typeof schema.mcpServers.$inferInsert;

export interface ListingServerRequest {
  orgId: string;
  workspaceId: string;
  /** The person connecting the server. The steering PR is opened for them. */
  userId: string | null;
  /** The plugin.installed_plugins row. `name` appears in refusals. */
  listing: { id: string; name: string };
  /** The columns a new proposed row is written with. */
  values: Pick<
    ServerInsert,
    | "name"
    | "transportType"
    | "endpointUrl"
    | "authStrategy"
    | "healthStatus"
    | "discoveredTools"
  > &
    Partial<Pick<ServerInsert, "lastHealthcheckAt" | "createdById">>;
  /** The columns an existing row takes when it becomes the proposal. */
  refresh: Partial<
    Pick<
      ServerInsert,
      | "name"
      | "endpointUrl"
      | "healthStatus"
      | "lastHealthcheckAt"
      | "discoveredTools"
    >
  >;
  /**
   * Runs after the proposed row is written and before the PR opens. The OAuth
   * sign-in pins the tools it listed here, so the folder the PR adds lists
   * them. A throw rolls the row back, as a PR that did not open does.
   */
  beforeOpen?: (serverId: string) => Promise<void>;
  /** The capability asking, for the log line. */
  caller: string;
}

export type ListingServerOutcome =
  | { kind: "held" }
  | { kind: "pending"; folder: string }
  | {
      kind: "proposed";
      serverId: string;
      publicId: string;
      pr: OpenedSteeringPr;
    };

/**
 * Decide how a listing's server is connected in a migrated workspace, and
 * open the steering PR when it is a proposal. See the file header.
 */
export async function proposeListingServer(
  writer: ServerFolderWriter,
  request: ListingServerRequest,
): Promise<ListingServerOutcome> {
  const s = schema.mcpServers;
  const { orgId, workspaceId, userId, listing } = request;
  // The listing index covers deleted rows too, so the lookup reads them.
  const existing = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        id: s.id,
        publicId: s.publicId,
        origin: s.origin,
        steeringName: s.steeringName,
        enabled: s.enabled,
        deletedAt: s.deletedAt,
        deletedById: s.deletedById,
      })
      .from(s)
      .where(
        and(
          eq(s.orgId, orgId),
          eq(s.workspaceId, workspaceId),
          eq(s.orgListingId, listing.id),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (existing !== null && existing.deletedAt === null) {
    if (
      existing.origin === "steering" ||
      (existing.origin === "legacy" && existing.steeringName !== null)
    ) {
      return { kind: "held" };
    }
    if (existing.origin === "proposed" && existing.steeringName !== null) {
      return { kind: "pending", folder: existing.steeringName };
    }
  }

  // The undo only touches a row that is still proposed with no folder name.
  // A concurrent request that reserved a name keeps its row and its PR.
  const stillUnnamedProposal = (id: string) =>
    and(
      eq(s.id, id),
      eq(s.workspaceId, workspaceId),
      eq(s.origin, "proposed"),
      isNull(s.steeringName),
    );

  const inProgress = () =>
    new HandlerError({
      code: "conflict",
      reason: "plugin_enable_in_progress",
      message: `Another request is enabling "${listing.name}" in this workspace. Try again in a moment.`,
    });

  let row: { id: string; publicId: string };
  let undo: () => Promise<unknown>;
  if (existing !== null) {
    // The update matches only the origin and folder name this request read.
    // A concurrent request that already changed the row, or reserved a folder
    // name for it, keeps its PR, and this request stops instead of clearing
    // the name and opening a second PR.
    const [converted] = await withTenantDb((tx) =>
      tx
        .update(s)
        .set({
          ...request.refresh,
          origin: "proposed",
          enabled: false,
          steeringName: null,
          deletedAt: null,
          deletedById: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(s.id, existing.id),
            eq(s.workspaceId, workspaceId),
            eq(s.origin, existing.origin),
            existing.steeringName === null
              ? isNull(s.steeringName)
              : eq(s.steeringName, existing.steeringName),
          ),
        )
        .returning({ id: s.id }),
    );
    if (converted === undefined) throw inProgress();
    row = { id: existing.id, publicId: existing.publicId };
    undo = () =>
      withTenantDb((tx) =>
        tx
          .update(s)
          .set({
            origin: existing.origin,
            enabled: existing.enabled,
            steeringName: existing.steeringName,
            deletedAt: existing.deletedAt,
            deletedById: existing.deletedById,
            updatedAt: new Date(),
          })
          .where(stillUnnamedProposal(existing.id)),
      );
  } else {
    const [inserted] = await withTenantDb((tx) =>
      tx
        .insert(s)
        .values({
          authConfig: {},
          ...request.values,
          orgId,
          workspaceId,
          orgListingId: listing.id,
          enabled: false,
          origin: "proposed",
        })
        // onConflictDoNothing names the partial index's predicate `where`, not
        // `targetWhere`, and renders it as ON CONFLICT (...) WHERE ... DO NOTHING.
        .onConflictDoNothing({
          target: [s.workspaceId, s.orgListingId],
          where: sql`org_listing_id IS NOT NULL`,
        })
        .returning({ id: s.id, publicId: s.publicId }),
    );
    if (inserted === undefined) throw inProgress();
    row = inserted;
    undo = () =>
      withTenantDb((tx) =>
        tx
          .update(s)
          .set({
            deletedAt: new Date(),
            deletedById: userId,
            updatedAt: new Date(),
          })
          .where(stillUnnamedProposal(inserted.id)),
      );
  }

  let pr: OpenedSteeringPr;
  try {
    if (request.beforeOpen !== undefined) await request.beforeOpen(row.id);
    pr = await writer.addServer({
      orgId,
      workspaceId,
      serverId: row.id,
      actorUserId: userId,
    });
  } catch (err) {
    await undo().catch((undoErr: unknown) => {
      logger.error(
        {
          err: undoErr,
          serverId: row.id,
          orgListingId: listing.id,
          workspaceId,
        },
        `${request.caller}: the steering PR did not open and the proposed row was not rolled back`,
      );
    });
    throw err;
  }
  return { kind: "proposed", serverId: row.id, publicId: row.publicId, pr };
}
