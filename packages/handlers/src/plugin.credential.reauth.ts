// audit-exempt: read-only — resolves slugs and returns an OAuth authorize URL. It mutates no credential and grants no access (the actual token exchange happens later in the OAuth callback route). Covered by the kernel capability.invoke_* audit.
import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

/**
 * Returns the OAuth authorize URL for re-authenticating a plugin credential.
 * The caller (Plan 5 notification deep-link, or UI "Re-connect" button) opens
 * this URL to start the standard MCP OAuth 2.1 flow.
 *
 * URL shape: {APP_URL}/api/v1/mcp/oauth/authorize?orgSlug=...&workspaceSlug=...&orgListingId=...
 */
export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId } = input as { orgListingId: string };

  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.credential.reauth] workspaceId is required (scoped capability)",
    );
  }

  // Resolve org slug + workspace slug from the context ids.
  let slugs: { orgSlug: string | null; workspaceSlug: string | null };
  try {
    slugs = await withSystemDb(async (tx) => {
      const [orgRow] = await tx
        .select({ slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .limit(1);
      const [wsRow] = await tx
        .select({ slug: schema.workspaces.slug })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, ctx.workspaceId!),
            eq(schema.workspaces.orgId, ctx.orgId),
          ),
        )
        .limit(1);
      return {
        orgSlug: orgRow?.slug ?? null,
        workspaceSlug: wsRow?.slug ?? null,
      };
    });
  } catch (err) {
    logger.error(
      { err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "plugin.credential.reauth: slug lookup failed",
    );
    throw err;
  }

  if (!slugs.orgSlug || !slugs.workspaceSlug) {
    throw new Error(
      "[plugin.credential.reauth] could not resolve org or workspace slug",
    );
  }

  const appUrl =
    process.env["APP_URL"] ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "";
  if (!appUrl) {
    throw new Error(
      "[plugin.credential.reauth] APP_URL environment variable is not set",
    );
  }

  const params = new URLSearchParams({
    orgSlug: slugs.orgSlug,
    workspaceSlug: slugs.workspaceSlug,
    orgListingId,
  });
  const authorizeUrl = `${appUrl}/api/v1/mcp/oauth/authorize?${params.toString()}`;

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "plugin.credential.reauth: ok",
  );
  return { authorizeUrl };
};
