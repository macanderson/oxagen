// store.ts: the mcp.relays rows, read and written in one place (M12, #4685).
//
// Every caller passes a withSystemDb transaction on the shared plane. The
// verifier looks a token up by its hash before any organization is known, so
// the table is read there, and create_relay and revoke_relay write it there
// too. RLS is bypassed on that plane, so the orgId and workspaceId predicates
// below are the only fence between one workspace's relays and another's.
// store.test.ts proves each statement carries them.
import { schema, type Tx } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";

/** The organization and workspace a create or revoke runs in. */
export interface RelayScope {
  orgId: string;
  workspaceId: string;
}

/** A relay row, as create_relay and revoke_relay answer it. */
export interface RelayRow {
  publicId: string;
  name: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** The fields the verifier needs to name a token's owner. */
export interface RelayIdentityRow {
  orgId: string;
  workspaceId: string;
  workspacePublicId: string;
  name: string;
}

const relayColumns = {
  publicId: schema.mcpRelays.publicId,
  name: schema.mcpRelays.name,
  createdAt: schema.mcpRelays.createdAt,
  revokedAt: schema.mcpRelays.revokedAt,
};

/** The workspace's public id, wrk_…, or null when the workspace is not in this organization. */
export async function readWorkspacePublicId(
  tx: Tx,
  scope: RelayScope,
): Promise<string | null> {
  const [row] = await tx
    .select({ publicId: schema.workspaces.publicId })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.orgId, scope.orgId),
        eq(schema.workspaces.id, scope.workspaceId),
      ),
    )
    .limit(1);
  return row?.publicId ?? null;
}

/** The live relay with this name in the workspace, or null. */
export async function findLiveRelay(
  tx: Tx,
  scope: RelayScope,
  name: string,
): Promise<RelayRow | null> {
  const [row] = await tx
    .select(relayColumns)
    .from(schema.mcpRelays)
    .where(
      and(
        eq(schema.mcpRelays.orgId, scope.orgId),
        eq(schema.mcpRelays.workspaceId, scope.workspaceId),
        eq(schema.mcpRelays.name, name),
        isNull(schema.mcpRelays.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The values a new relay row is written with. `tokenHash` is the SHA-256, never the token. */
export interface NewRelay {
  scope: RelayScope;
  workspacePublicId: string;
  name: string;
  tokenHash: string;
  createdById: string;
  createdAt: Date;
}

/** Write a new live relay and answer its row. */
export async function insertRelay(tx: Tx, relay: NewRelay): Promise<RelayRow> {
  const [row] = await tx
    .insert(schema.mcpRelays)
    .values({
      orgId: relay.scope.orgId,
      workspaceId: relay.scope.workspaceId,
      workspacePublicId: relay.workspacePublicId,
      name: relay.name,
      tokenHash: relay.tokenHash,
      createdById: relay.createdById,
      createdAt: relay.createdAt,
    })
    .returning(relayColumns);
  if (!row) throw new Error("mcp.relays insert returned no row");
  return row;
}

/**
 * Revoke the live relay with this name in the workspace and answer its row,
 * or null when the workspace holds no live relay by that name.
 */
export async function revokeLiveRelay(
  tx: Tx,
  scope: RelayScope,
  name: string,
  actorUserId: string,
  at: Date,
): Promise<RelayRow | null> {
  const [row] = await tx
    .update(schema.mcpRelays)
    .set({ revokedAt: at, revokedById: actorUserId })
    .where(
      and(
        eq(schema.mcpRelays.orgId, scope.orgId),
        eq(schema.mcpRelays.workspaceId, scope.workspaceId),
        eq(schema.mcpRelays.name, name),
        isNull(schema.mcpRelays.revokedAt),
      ),
    )
    .returning(relayColumns);
  return row ?? null;
}

/** The live relay whose token hashes to `tokenHash`, or null. A revoked row never matches. */
export async function findLiveRelayByHash(
  tx: Tx,
  tokenHash: string,
): Promise<RelayIdentityRow | null> {
  const [row] = await tx
    .select({
      orgId: schema.mcpRelays.orgId,
      workspaceId: schema.mcpRelays.workspaceId,
      workspacePublicId: schema.mcpRelays.workspacePublicId,
      name: schema.mcpRelays.name,
    })
    .from(schema.mcpRelays)
    .where(
      and(
        eq(schema.mcpRelays.tokenHash, tokenHash),
        isNull(schema.mcpRelays.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
