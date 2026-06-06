/**
 * resolveWorkspaceScope — transport-agnostic workspace scope resolution.
 *
 * Resolves a workspace slug within an org to a workspaceId. The composite
 * unique index (org_id, slug) enforces that slug lookups are always scoped to
 * the resolved org — a slug that exists in another org returns not_found.
 *
 * This function has no HTTP dependency — it can be called identically from
 * API middleware, MCP handler, CLI, or tests.
 */
import { and, eq } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";

export interface WorkspaceScopeResult {
  workspaceId: string;
}

export type WorkspaceScopeResolution =
  | ({ ok: true } & WorkspaceScopeResult)
  | { ok: false; kind: "not_found" };

/**
 * Resolves a workspace slug within a confirmed orgId to a workspaceId.
 *
 * @param orgId - The already-resolved org ID (from resolveOrgScope or an
 *   API-key's pre-bound orgId). The lookup is always scoped to this org, so
 *   a slug that exists in another org will correctly return not_found.
 * @param slug - The workspace slug from the request path.
 * @returns WorkspaceScopeResolution — ok:true with workspaceId on success,
 *   ok:false with kind "not_found" when the workspace does not exist in this
 *   org.
 */
export async function resolveWorkspaceScope(
  orgId: string,
  slug: string,
): Promise<WorkspaceScopeResolution> {
  // tenancy: system bypass via withSystemDb (identity resolution before a tenant scope exists) — OXA-1515
  // Resolves (orgId, slug) → workspaceId. This is the resolution step: it
  // produces the workspaceId needed to construct a tenant scope. The workspaces
  // table is an identity/routing table queried here purely to establish which
  // tenant scope applies — no tenant-owned payload is accessed.
  const ws = await withSystemDb((tx) =>
    tx.query.workspaces.findFirst({
      where: and(eq(schema.workspaces.orgId, orgId), eq(schema.workspaces.slug, slug)),
      columns: { id: true },
    }),
  );

  if (!ws) return { ok: false, kind: "not_found" };

  return { ok: true, workspaceId: ws.id };
}
