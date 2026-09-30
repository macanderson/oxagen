import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import type { RunScope } from "../run.list";

/** Ledger runs carry no harness. Wrapped runs use the recorded session harness. */
export async function readRunHarnesses(
  scope: RunScope,
  runIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(runIds)].filter((id) => id.startsWith("tse_"));
  if (ids.length === 0) return new Map();
  const sessions = schema.tachoSessions;
  const rows = await withTenantDb((tx) =>
    tx
      .select({ publicId: sessions.publicId, harness: sessions.harness })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          inArray(sessions.publicId, ids),
        ),
      ),
  );
  return new Map(rows.map((row) => [row.publicId, row.harness || null]));
}
