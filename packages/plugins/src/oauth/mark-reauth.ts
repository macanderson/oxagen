import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";

/**
 * Flip a credential row to needs_reauth.
 * Called by the runtime MCP contributor and the refresh-watcher cron
 * when an OAuth token exchange or refresh fails. Plan 5 notifies on this status.
 */
export async function markCredentialNeedsReauth(
  workspaceId: string,
  orgListingId: string,
): Promise<void> {
  await withSystemDb(async (tx) => {
    await tx
      .update(schema.mcpCredentials)
      .set({ status: "needs_reauth", updatedAt: new Date() })
      .where(
        and(
          eq(schema.mcpCredentials.workspaceId, workspaceId),
          eq(schema.mcpCredentials.orgListingId, orgListingId),
        ),
      );
  });
}
