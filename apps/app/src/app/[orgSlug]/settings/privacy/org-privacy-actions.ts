"use server";
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen/kernel";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember, assertSecurityManager } from "@/lib/resolve-org";
import { withSystemDb, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";

interface ExportResult {
  exportId: string;
  status: string;
}

interface EraseResult {
  requestId: string;
  status: string;
  effectiveAt: string;
}

export async function requestOrgDataExportAction(orgSlug: string): Promise<ExportResult> {
  const [session, org] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(org.id, session.user.id);

  const result = await invoke(
    "privacy.data.export",
    { scope: "org", orgId: org.id },
    { userId: session.user.id, orgId: org.id, workspaceId: "00000000-0000-0000-0000-000000000000", apiKeyId: null, surface: "app", requestId: crypto.randomUUID(), messageId: null },
    { surface: "api" },
  );
  return result as ExportResult;
}

export async function requestOrgDataEraseAction(orgSlug: string): Promise<EraseResult> {
  const [session, org] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  // Org-wide data erase is destructive and irreversible: require an owner/admin
  // role, not mere membership. assertSecurityManager 404s a non-manager (it
  // re-reads the caller's own (orgId, userId) role row), so a member of org A
  // cannot erase org B by guessing its slug, and a non-owner member of org A
  // cannot erase their own org. The handler also enforces this; this is the
  // action-layer gate that closes the IDOR before invoke() is ever reached.
  await assertSecurityManager(org.id, session.user.id);

  const result = await invoke(
    "privacy.data.erase",
    { scope: "org", orgId: org.id, confirm: true },
    { userId: session.user.id, orgId: org.id, workspaceId: "00000000-0000-0000-0000-000000000000", apiKeyId: null, surface: "app", requestId: crypto.randomUUID(), messageId: null },
    { surface: "api" },
  );
  return result as EraseResult;
}

export async function getOrgExportStatusAction(orgSlug: string, exportId: string) {
  // withSystemDb bypasses RLS, so the query MUST be constrained to the caller's
  // org. Without resolveOrg + assertOrgMember + the orgId filter, any authed
  // user could poll any export id and read another org's signed download URL.
  const [session, org] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(org.id, session.user.id);

  const rows = await withSystemDb((tx) =>
    tx
      .select({
        status: schema.privacyExportRequests.status,
        exportUrl: schema.privacyExportRequests.exportUrl,
        orgId: schema.privacyExportRequests.orgId,
      })
      .from(schema.privacyExportRequests)
      .where(
        and(
          eq(schema.privacyExportRequests.id, exportId),
          eq(schema.privacyExportRequests.orgId, org.id),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) return null;

  // Authorize: the caller must be a member of the org that owns this export.
  // assertOrgMember() calls notFound() (treated as 404) for non-members, so a
  // foreign exportId is indistinguishable from a missing one — no cross-org
  // leak of the signed export URL.
  await assertOrgMember(row.orgId, session.user.id);

  return { status: row.status, exportUrl: row.exportUrl };
}
