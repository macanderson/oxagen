import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import type { AppEnv } from "../app";

/** The `reason` a 403 carries when a key's workspace is not the one the URL names. `oxagen check` reads it. */
const KEY_SCOPE_MISMATCH = "key_scope_mismatch";

/** Whether a URL segment names the scope: its id, or its slug in any case, as the citext column compares. */
function names(
  segment: string | undefined,
  id: string,
  slug: string,
): boolean {
  return (
    segment !== undefined &&
    (segment === id || segment.toLowerCase() === slug.toLowerCase())
  );
}

/**
 * Refuses an API key whose workspace is not the one the URL names.
 *
 * An API key carries its organization and workspace, and the org and
 * workspace middleware keep that scope without reading the URL's slugs. So a
 * request for `/v1/acme/prod/...` made with a key for `acme/dev` would answer
 * with `acme/dev`'s data. This check fails that request with 403
 * `key_scope_mismatch` instead, and the message names both workspaces.
 *
 * A session request resolved its scope from the URL's slugs already, so the
 * check passes it through without a query.
 */
export const keyScopeMatchesPath: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  if (!c.get("apiKeyId")) return next();
  const orgId = c.get("orgId") ?? "";
  const workspaceId = c.get("workspaceId") ?? "";

  // tenancy: system bypass via withSystemDb. The lookup reads the two slugs of the orgId and workspaceId an authenticated API key carries, by primary key, and returns no tenant payload.
  const key = await withSystemDb(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, orgId),
      columns: { slug: true },
    });
    const workspace = await tx.query.workspaces.findFirst({
      where: eq(schema.workspaces.id, workspaceId),
      columns: { slug: true },
    });
    return {
      org: org?.slug ?? orgId,
      workspace: workspace?.slug ?? workspaceId,
    };
  });

  const orgSegment = c.req.param("org_slug");
  const workspaceSegment = c.req.param("workspace_slug");
  if (
    names(orgSegment, orgId, key.org) &&
    names(workspaceSegment, workspaceId, key.workspace)
  ) {
    return next();
  }

  const held = `${key.org}/${key.workspace}`;
  const asked = `${orgSegment ?? ""}/${workspaceSegment ?? ""}`;
  throw new HandlerError({
    code: "forbidden",
    reason: KEY_SCOPE_MISMATCH,
    message: `This API key belongs to workspace ${held}, and the request names ${asked}. Use a key for ${asked}, or request ${held}.`,
  });
};
