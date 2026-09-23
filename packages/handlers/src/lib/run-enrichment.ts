import { schema, withTenantDb } from "@oxagen/database";
import { runEnrichmentEnabled } from "@oxagen/oxagen/run-enrichment";
import { and, eq } from "drizzle-orm";
import type { RunScope } from "../run.list";

export async function readRunEnrichmentEnabled(
  scope: RunScope,
): Promise<boolean> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, scope.orgId),
          eq(schema.workspaces.id, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  return row !== undefined && runEnrichmentEnabled(row.settings);
}
