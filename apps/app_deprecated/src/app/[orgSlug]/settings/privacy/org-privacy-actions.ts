"use server";
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen/kernel";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  assertOrgMember,
  assertSecurityManager,
} from "@/lib/resolve-org";
import { withSystemDb, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";

/** Sentinel workspaceId for org-only capabilities (no workspace context). */
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

interface ExportResult {
  exportId: string;
  status: string;
}

interface EraseResult {
  requestId: string;
  status: string;
  effectiveAt: string;
}

export async function requestOrgDataExportAction(
  orgSlug: string,
): Promise<ExportResult> {
  const [session, org] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  // An org export bundles EVERY member's profile, every workspace config, and
  // every conversation into one downloadable archive — it is a whole-tenant
  // data pull, not a self-service download. Membership alone would let any
  // member exfiltrate their colleagues' data, so this needs the same owner/admin
  // gate as the erase below (and as the UI already advertises).
  await assertSecurityManager(org.id, session.user.id);

  const result = await invoke(
    "export_data",
    { scope: "org", orgId: org.id },
    {
      userId: session.user.id,
      orgId: org.id,
      workspaceId: ORG_ONLY_WS,
      apiKeyId: null,
      surface: "app",
      requestId: crypto.randomUUID(),
      messageId: null,
    },
    { surface: "api" },
  );
  return result as ExportResult;
}

export async function requestOrgDataEraseAction(
  orgSlug: string,
): Promise<EraseResult> {
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
    "erase_data",
    { scope: "org", orgId: org.id, confirm: true },
    {
      userId: session.user.id,
      orgId: org.id,
      workspaceId: ORG_ONLY_WS,
      apiKeyId: null,
      surface: "app",
      requestId: crypto.randomUUID(),
      messageId: null,
    },
    { surface: "api" },
  );
  return result as EraseResult;
}

export async function getOrgExportStatusAction(
  orgSlug: string,
  exportId: string,
): Promise<{ status: string; exportUrl: string | null } | null> {
  // withSystemDb bypasses RLS, so authorization is enforced on two axes here:
  //   1. assertOrgMember() — the caller must belong to the org named in the URL
  //      (notFound()/404 otherwise, so a foreign org is indistinguishable from
  //      an unknown one).
  //   2. the org_id predicate below — the row must belong to THAT org, so a
  //      foreign exportId returns null rather than another org's signed
  //      download URL.
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
  return { status: row.status, exportUrl: row.exportUrl };
}
