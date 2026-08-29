/**
 * resolveWorkspaceScope — transport-agnostic workspace scope resolution.
 *
 * Resolves a workspace slug within an org to a workspaceId. When a userId is
 * provided it also verifies that the user is a member of the workspace,
 * preventing cross-workspace data access inside the same org.
 *
 * The composite unique index (org_id, slug) enforces that slug lookups are
 * always scoped to the resolved org — a slug that exists in another org
 * returns not_found.
 *
 * This function has no HTTP dependency — it can be called identically from
 * API middleware, MCP handler, CLI, or tests.
 */
import { and, eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";

export interface WorkspaceScopeResult {
  workspaceId: string;
}

export type WorkspaceScopeResolutionError =
  | { kind: "not_found" }
  | { kind: "not_member" };

export type WorkspaceScopeResolution =
  | ({ ok: true } & WorkspaceScopeResult)
  | ({ ok: false } & WorkspaceScopeResolutionError);

/**
 * Resolves a workspace slug within a confirmed orgId to a workspaceId.
 *
 * @param orgId - The already-resolved org ID (from resolveOrgScope or an
 *   API-key's pre-bound orgId). The lookup is always scoped to this org, so
 *   a slug that exists in another org will correctly return not_found.
 * @param slug - The workspace slug from the request path.
 * @param userId - Optional. When provided, the function also verifies that the
 *   user is a member of the workspace (workspace.workspace_users row exists).
 *   Returns ok:false with kind "not_member" when the workspace exists but the
 *   user is not a member. This enforces workspace isolation at the transport
 *   layer, independent of IAM enforcement flags — a user in workspace A cannot
 *   access workspace B's resources within the same org.
 *   API-key-authenticated requests omit userId (the key's pre-bound
 *   workspaceId already enforces scope).
 * @returns WorkspaceScopeResolution — ok:true with workspaceId on success,
 *   ok:false with kind "not_found" (workspace absent) or "not_member" (user
 *   not a member of the workspace).
 */
export async function resolveWorkspaceScope(
  orgId: string,
  slug: string,
  userId?: string | null,
): Promise<WorkspaceScopeResolution> {
  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists)
  // Resolves (orgId, slug) → workspaceId. This is the resolution step: it
  // produces the workspaceId needed to construct a tenant scope. The workspaces
  // table is an identity/routing table queried here purely to establish which
  // tenant scope applies — no tenant-owned payload is accessed.
  const ws = await withSystemDb((tx) =>
    tx.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.orgId, orgId),
        eq(schema.workspaces.slug, slug),
      ),
      columns: { id: true },
    }),
  );

  if (!ws) return { ok: false, kind: "not_found" };

  // Membership check: when a userId is supplied, verify the user has a row in
  // workspace.workspace_users for this workspace. This enforces workspace
  // isolation at the transport layer regardless of IAM enforcement state —
  // a ws-alpha session must never access ws-beta resources within the same org.
  // withSystemDb bypasses RLS legitimately here (identity/routing table, no
  // tenant payload returned).
  if (userId) {
    const membership = await withSystemDb((tx) =>
      tx.query.workspaceUsers.findFirst({
        where: and(
          eq(schema.workspaceUsers.workspaceId, ws.id),
          eq(schema.workspaceUsers.userId, userId),
        ),
        columns: { id: true },
      }),
    );
    if (!membership) return { ok: false, kind: "not_member" };
  }

  return { ok: true, workspaceId: ws.id };
}
