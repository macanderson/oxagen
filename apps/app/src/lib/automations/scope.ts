/**
 * automations/scope.ts — shared server-side scope + IAM resolution for the
 * Automations cluster (Automations list/editor, Triggers board, Workflows).
 *
 * apps/app does NOT bootstrap the IAM kernel (see CLAUDE.md gotcha), so every
 * server surface must gate explicitly. This centralizes the
 * session → org → workspace → member/role resolution so the Automations,
 * Triggers, and Workflows pages all gate identically. Mirrors the canonical
 * pattern in lib/workbench/scope.ts but decoupled from the Workbench module.
 *
 * The `ctx.surface` is "app" for attribution/metering. invoke() is called with
 * NO opts.surface override: the kernel's surface allowlist gate only fires when
 * opts.surface is explicitly set (kernel.ts:578), so omitting it keeps the
 * automation.* / workflow.* / research.swarm.* contracts (which
 * list "agent" but not "app" in surfaces[]) reachable from this trusted
 * first-party surface, with honest "app" attribution.
 *
 * Server-only: imports invoke handlers and tenant DB. Never import from a
 * "use client" module.
 */
import "@oxagen/handlers/register";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

/**
 * The invoke() context every Automations capability call needs. surface:"app"
 * tags attribution/metering as app-originated; the surface *gate* is satisfied
 * per-call via `{ surface: "agent" }` opts.
 */
export type AutomationsCtx = {
  orgId: string;
  workspaceId: string;
  userId: string;
  apiKeyId: string | null;
  requestId: string;
  surface: "app";
  messageId: string | null;
};

/** Build a fresh invoke() context (unique requestId per call) from resolved ids. */
export function buildAutomationsCtx(input: {
  orgId: string;
  workspaceId: string;
  userId: string;
}): AutomationsCtx {
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

export type ResolvedAutomationsScope = {
  session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  org: Awaited<ReturnType<typeof resolveOrg>>;
  ws: Awaited<ReturnType<typeof resolveWorkspace>>;
  ctx: AutomationsCtx;
  /**
   * True when the viewer is a workspace Owner/Admin. Gates the sensitive
   * mutations — enable/disable/trigger an automation, create/update/delete a
   * trigger, launch/cancel a workflow — since apps/app skips the IAM kernel.
   */
  canManage: boolean;
};

/**
 * Resolve the current session to a scoped, IAM-gated Automations context.
 * Redirects to /login when unauthenticated (via getSessionOrRedirect); throws
 * (Next notFound-style) when the org/workspace do not resolve or the user is
 * not an org member.
 */
export async function resolveAutomationsScope(
  orgSlug: string,
  workspaceSlug: string,
): Promise<ResolvedAutomationsScope> {
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

  const ctx = buildAutomationsCtx({
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
  });

  return { session, org, ws, ctx, canManage };
}
