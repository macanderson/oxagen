/**
 * workbench/scope.ts — shared server-side scope + IAM resolution for Workbench.
 *
 * apps/app does NOT bootstrap the IAM kernel (see CLAUDE.md gotcha), so every
 * server surface must gate explicitly. This module centralizes the
 * session → org → workspace → member/role resolution so the Agents, Tools,
 * Skills, and Marketplace surfaces all gate identically instead of each
 * re-deriving it. Mirrors the canonical pattern in
 * settings/skills/skill-actions.ts.
 *
 * Server-only: imports invoke handlers and tenant DB. Never import from a
 * "use client" module.
 */
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";

/** The invoke() context every Workbench capability call needs. */
export type WorkbenchCtx = {
  orgId: string;
  workspaceId: string;
  userId: string;
  apiKeyId: string | null;
  requestId: string;
  surface: "app";
  messageId: string | null;
};

/** Build the invoke() context from resolved ids. */
export function buildWorkbenchCtx(input: {
  orgId: string;
  workspaceId: string;
  userId: string;
}): WorkbenchCtx {
  return {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };
}

export type ResolvedWorkbenchScope = {
  session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  org: Awaited<ReturnType<typeof resolveOrg>>;
  ws: Awaited<ReturnType<typeof resolveWorkspace>>;
  ctx: WorkbenchCtx;
  /** True when the viewer is a workspace Owner/Admin — gates create/publish/deploy. */
  canManage: boolean;
};

/**
 * Resolve the current session to a scoped, IAM-gated Workbench context.
 * Redirects to /login when unauthenticated (via getSessionOrRedirect).
 * Throws (Next notFound-style) when the org/workspace do not resolve.
 */
export async function resolveWorkbenchScope(
  orgSlug: string,
  workspaceSlug: string,
): Promise<ResolvedWorkbenchScope> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const roleRows = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.workspaceUsers.role })
          .from(schema.workspaceUsers)
          .where(
            and(
              eq(schema.workspaceUsers.workspaceId, ws.id),
              eq(schema.workspaceUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );
  const role = (roleRows[0]?.role ?? "").toLowerCase();
  const canManage = ["owner", "admin"].includes(role);

  const ctx = buildWorkbenchCtx({
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
  });

  return { session, org, ws, ctx, canManage };
}
