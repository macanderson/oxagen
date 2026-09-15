// credential-grants.ts — the credential broker's log (MC spec §6.8, ADR-065,
// #2958).
//
// A wrapped agent holds no credentials. When the tool gateway reaches an MCP
// server on a run's behalf it takes the workspace's stored credential
// (`mcp.credentials`, the connection) and presents it server-side; the agent
// only ever sees the tool's result. Every such use is a grant: one
// `mcp.credential_grants` row naming the connection, the server, the scope the
// credential could reach and its lifetime. The secret never lands here.
//
// The downscope the broker achieves today is `none` — the stored credential
// used server-side for this connection only (spec §6.8, last row). Token
// exchange, session policies and restricted keys arrive per provider; a grant
// written then names the method it used in the same column.
//
// Revoking a connection revokes its live grants; a connection kill switch does
// the same, and while it is on no new grant is minted: the gateway resolves
// the connection (`findCredentialConnection`), checks the switches against
// it, and records the grant, all before the credential is presented. The
// list read is `list_credential_grants`.

import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";

/** The longest a grant lives (spec §6.8: "never more than one hour"). */
export const CREDENTIAL_GRANT_MAX_TTL_MS = 60 * 60 * 1000;

interface CredentialGrantScope {
  readonly endpointUrl: string;
  readonly authKind: "oauth" | "secret";
  readonly downscope:
    | "token_exchange"
    | "session_policy"
    | "restricted_key"
    | "none";
}

/** The workspace's stored credential for a listing: the connection a grant draws on. */
export interface CredentialConnection {
  /** `mcp.credentials.id` */
  readonly id: string;
  /** `mcrd_…` */
  readonly publicId: string;
  readonly authKind: "oauth" | "secret";
}

/**
 * The connection the workspace holds for `orgListingId`, or null when it
 * holds none. Runs inside the caller's tenant scope.
 */
export async function findCredentialConnection(args: {
  orgId: string;
  workspaceId: string;
  /** The installed plugin the credential belongs to (`mcp.credentials.org_listing_id`). */
  orgListingId: string;
}): Promise<CredentialConnection | null> {
  const [credential] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.mcpCredentials.id,
        publicId: schema.mcpCredentials.publicId,
        authKind: schema.mcpCredentials.authKind,
      })
      .from(schema.mcpCredentials)
      .where(
        and(
          eq(schema.mcpCredentials.orgId, args.orgId),
          eq(schema.mcpCredentials.workspaceId, args.workspaceId),
          eq(schema.mcpCredentials.orgListingId, args.orgListingId),
        ),
      )
      .limit(1),
  );
  if (!credential) return null;
  return {
    id: credential.id,
    publicId: credential.publicId,
    authKind: credential.authKind === "oauth" ? "oauth" : "secret",
  };
}

interface RecordCredentialGrantArgs {
  orgId: string;
  workspaceId: string;
  /** The connection put to use, as `findCredentialConnection` resolved it. */
  connection: CredentialConnection;
  /** The server the credential was presented to (`mcp.mcp_servers.id`). */
  mcpServerId: string;
  endpointUrl: string;
  /** The governed run the use serves; null for a turn outside a run. */
  runId: string | null;
  /** The provider's own id for a minted token, where one exists. */
  providerTokenId?: string | null;
  now?: Date;
}

interface RecordedCredentialGrant {
  readonly grantId: string;
  /** `mcp.credentials.id` — the connection the grant drew on. */
  readonly connectionId: string;
  readonly expiresAt: Date;
}

/**
 * Record that `connection` was put to use for `mcpServerId`. Runs inside the
 * caller's tenant scope.
 */
export async function recordCredentialGrant(
  args: RecordCredentialGrantArgs,
): Promise<RecordedCredentialGrant> {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CREDENTIAL_GRANT_MAX_TTL_MS);
  return withTenantDb(async (tx) => {
    const scope: CredentialGrantScope = {
      endpointUrl: args.endpointUrl,
      authKind: args.connection.authKind,
      downscope: "none",
    };
    const [grant] = await tx
      .insert(schema.mcpCredentialGrants)
      .values({
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        connectionId: args.connection.id,
        connectionPublicId: args.connection.publicId,
        mcpServerId: args.mcpServerId,
        runId: args.runId,
        scope,
        providerTokenId: args.providerTokenId ?? null,
        issuedAt: now,
        expiresAt,
      })
      .returning({ id: schema.mcpCredentialGrants.id });
    if (!grant) throw new Error("credential_grants INSERT returned no row");
    return { grantId: grant.id, connectionId: args.connection.id, expiresAt };
  });
}

/**
 * Revoke every live grant drawn on a connection: a revoked connection's grants
 * die with it (spec §6.8). Returns how many were revoked. Runs in the caller's
 * transaction so a connection kill switch and its grant revocation commit
 * together.
 */
export async function revokeCredentialGrants(
  tx: Tx,
  args: { connectionId: string; now?: Date },
): Promise<number> {
  const revoked = await tx
    .update(schema.mcpCredentialGrants)
    .set({ revokedAt: args.now ?? new Date() })
    .where(
      and(
        eq(schema.mcpCredentialGrants.connectionId, args.connectionId),
        isNull(schema.mcpCredentialGrants.revokedAt),
      ),
    )
    .returning({ id: schema.mcpCredentialGrants.id });
  return revoked.length;
}
