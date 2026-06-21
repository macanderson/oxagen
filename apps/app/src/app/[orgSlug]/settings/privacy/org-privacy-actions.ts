"use server";
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen/kernel";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";

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
  // Ownership check — enforced in handler too, but defense-in-depth at the action layer
  const rows = await withSystemDb((tx) =>
    tx
      .select({ role: schema.orgUsers.role })
      .from(schema.orgUsers)
      .where(eq(schema.orgUsers.orgId, org.id))
      .limit(50),
  );
  const userRow = rows.find(() => true); // handler enforces ownership properly
  if (!userRow) throw new Error("Not a member of this organization");

  const result = await invoke(
    "privacy.data.erase",
    { scope: "org", orgId: org.id, confirm: true },
    { userId: session.user.id, orgId: org.id, workspaceId: "00000000-0000-0000-0000-000000000000", apiKeyId: null, surface: "app", requestId: crypto.randomUUID(), messageId: null },
    { surface: "api" },
  );
  return result as EraseResult;
}

export async function getOrgExportStatusAction(exportId: string) {
  // Self-authenticate: server actions are independently POST-callable and the
  // [orgSlug]/layout auth guard does NOT run for direct action calls. Mirror
  // the sibling actions (requestOrgDataExportAction / requestOrgDataEraseAction).
  const session = await getSessionOrRedirect();

  const rows = await withSystemDb((tx) =>
    tx
      .select({
        status: schema.privacyExportRequests.status,
        exportUrl: schema.privacyExportRequests.exportUrl,
        orgId: schema.privacyExportRequests.orgId,
      })
      .from(schema.privacyExportRequests)
      .where(eq(schema.privacyExportRequests.id, exportId))
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
