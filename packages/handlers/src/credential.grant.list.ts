// credential.grant.list.ts — handler for the list_credential_grants capability
// (MC spec §6.8, #2958): the Connections tab's grants log.
//
// audit-exempt: read-only. Lists the broker's grant rows — connection, server,
// run, scope and lifetime — and never any secret material, which the table
// does not hold; the kernel's capability.invoke_* audit records the access.
//
// Flow:
//   1. Role gate — org Owner, Admin or Compliance (assertOrgRole, INV-29).
//   2. Decode the cursor (issued_at, id); a cursor this handler did not
//      write is invalid_input.
//   3. Read one row past the page, newest first, and compute each grant's
//      status against now.
//
// The row names its connection AND its server by the public id and name they
// carried at mint time. Neither is joined: revoking a credential deletes the
// connection row and plugin uninstall hard-deletes the server row
// (plugin.org.uninstall), and `mcp_server_id` carries no foreign key so the
// grant survives. Joining to the server threw `RangeError` on the first
// orphan, which is on page 1 under a newest-first order, so one uninstall made
// the log permanently unreadable for that workspace with no cursor past it.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  credentialGrantList,
  credentialGrantScopeSchema,
  type CredentialGrantItem,
} from "@oxagen/oxagen/contracts/credential.grant.list";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";

// ---- Cursor ---------------------------------------------------------------

type GrantCursor = { at: string; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeGrantCursor(cursor: GrantCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString(
    "base64url",
  );
}

function decodeGrantCursor(raw: string): GrantCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      Number.isNaN(Date.parse(value[0])) ||
      !UUID_RE.test(value[1])
    )
      return null;
    return { at: value[0], id: value[1] };
  } catch {
    return null;
  }
}

// ---- Query ----------------------------------------------------------------

export interface GrantRow {
  id: string;
  publicId: string;
  connectionPublicId: string;
  serverPublicId: string;
  serverName: string;
  runId: string | null;
  scope: unknown;
  providerTokenId: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type PageQuery = {
  cursor: GrantCursor | null;
  limit: number;
  connectionId: string | null;
};

const grants = schema.mcpCredentialGrants;

const issuedAtMs = sql`date_trunc('milliseconds', ${grants.issuedAt})`;

function beforeCursor(cursor: GrantCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const instant = new Date(cursor.at);
  return or(
    lt(issuedAtMs, instant),
    and(eq(issuedAtMs, instant), lt(grants.id, cursor.id)),
  );
}

function grantPageQuery(
  db: Pick<Tx, "select">,
  scope: { orgId: string; workspaceId: string },
  q: PageQuery,
) {
  return db
    .select({
      id: grants.id,
      publicId: grants.publicId,
      connectionPublicId: grants.connectionPublicId,
      serverPublicId: grants.mcpServerPublicId,
      serverName: grants.mcpServerName,
      runId: grants.runId,
      scope: grants.scope,
      providerTokenId: grants.providerTokenId,
      issuedAt: grants.issuedAt,
      expiresAt: grants.expiresAt,
      revokedAt: grants.revokedAt,
    })
    .from(grants)
    .where(
      and(
        eq(grants.orgId, scope.orgId),
        eq(grants.workspaceId, scope.workspaceId),
        q.connectionId === null
          ? undefined
          : eq(grants.connectionPublicId, q.connectionId),
        beforeCursor(q.cursor),
      ),
    )
    .orderBy(desc(issuedAtMs), desc(grants.id))
    .limit(q.limit + 1);
}

// ---- Mapping --------------------------------------------------------------

export function grantStatus(
  row: Pick<GrantRow, "expiresAt" | "revokedAt">,
  now: Date,
): CredentialGrantItem["status"] {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

function toItem(row: GrantRow, now: Date): CredentialGrantItem {
  const scope = credentialGrantScopeSchema.safeParse(row.scope);
  if (!scope.success) {
    // Written by the broker through the same shape; a row outside it is a
    // broken row and the read fails rather than guesses.
    throw new RangeError(
      `credential_grants ${row.publicId}: scope outside the schema`,
    );
  }
  return {
    id: row.publicId,
    connectionId: row.connectionPublicId,
    serverId: row.serverPublicId,
    serverName: row.serverName,
    runId: row.runId,
    scope: scope.data,
    providerTokenId: row.providerTokenId,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: grantStatus(row, now),
  };
}

// ---- The handler ------------------------------------------------------------

interface CredentialGrantListDeps {
  page(
    scope: { orgId: string; workspaceId: string },
    q: PageQuery,
  ): Promise<GrantRow[]>;
}

const postgresCredentialGrantListDeps: CredentialGrantListDeps = {
  page: (scope, q) => withTenantDb((tx) => grantPageQuery(tx, scope, q)),
};

export function createCredentialGrantListHandler(
  deps: CredentialGrantListDeps,
  now: () => Date = () => new Date(),
): CapabilityHandler<typeof credentialGrantList> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Compliance"] },
    );

    const cursor =
      input.cursor === undefined ? null : decodeGrantCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw new CapabilityError(
        credentialGrantList.name,
        "invalid_input",
        "invalid_cursor",
      );

    const rows = await deps.page(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      { cursor, limit: input.limit, connectionId: input.connectionId ?? null },
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const at = now();
    return {
      items: page.map((row) => toItem(row, at)),
      nextCursor:
        rows.length > input.limit && last
          ? encodeGrantCursor({ at: last.issuedAt.toISOString(), id: last.id })
          : null,
    };
  };
}

export const credentialGrantListHandler = createCredentialGrantListHandler(
  postgresCredentialGrantListDeps,
);
