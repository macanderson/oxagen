"use server";
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen/kernel";
import { getSessionOrRedirect } from "@/lib/session";
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

export async function requestUserDataExportAction(): Promise<ExportResult> {
  const session = await getSessionOrRedirect();
  // User's primary org for context
  const orgs = await withSystemDb((tx) =>
    tx
      .select({ id: schema.organizations.id })
      .from(schema.orgUsers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgUsers.orgId))
      .where(eq(schema.orgUsers.userId, session.user.id))
      .limit(1),
  );
  const orgId = orgs[0]?.id ?? "";

  const result = await invoke(
    "privacy.data.export",
    { scope: "user" },
    {
      userId: session.user.id,
      orgId,
      workspaceId: "00000000-0000-0000-0000-000000000000",
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      messageId: null,
      surface: "app",
    },
    { surface: "api" },
  );
  return result as ExportResult;
}

export async function requestUserDataEraseAction(): Promise<EraseResult> {
  const session = await getSessionOrRedirect();
  const orgs = await withSystemDb((tx) =>
    tx
      .select({ id: schema.organizations.id })
      .from(schema.orgUsers)
      .innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgUsers.orgId))
      .where(eq(schema.orgUsers.userId, session.user.id))
      .limit(1),
  );
  const orgId = orgs[0]?.id ?? "";

  const result = await invoke(
    "privacy.data.erase",
    { scope: "user", confirm: true },
    {
      userId: session.user.id,
      orgId,
      workspaceId: "00000000-0000-0000-0000-000000000000",
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      messageId: null,
      surface: "app",
    },
    { surface: "api" },
  );
  return result as EraseResult;
}

export async function getExportStatusAction(exportId: string) {
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        status: schema.privacyExportRequests.status,
        exportUrl: schema.privacyExportRequests.exportUrl,
        completedAt: schema.privacyExportRequests.completedAt,
      })
      .from(schema.privacyExportRequests)
      .where(eq(schema.privacyExportRequests.id, exportId))
      .limit(1),
  );
  return rows[0] ?? null;
}
