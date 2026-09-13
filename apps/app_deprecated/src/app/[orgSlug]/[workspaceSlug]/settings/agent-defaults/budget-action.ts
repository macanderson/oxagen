"use server";
/**
 * budget-action.ts — server action for Workspace → Settings → Budget.
 *
 * Writes the workspace's governed per-turn dollar budget via the
 * `workspace.budget.policy.write` capability. Owner/Admin-gated: `apps/app`
 * does NOT bootstrap IAM through invoke() (see CLAUDE.md gotcha — invoke()
 * called from apps/app skips the kernel's role checks entirely), so this
 * action re-reads the caller's workspace role server-side and rejects a
 * non-owner/admin BEFORE calling invoke() — mirroring the identical gate in
 * ./models-action.ts and ../general/actions.ts. Never trust a client-supplied
 * role flag.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("update_budget_policy", …) can resolve its handler. Without
// this, invoke() throws "No handler registered" at runtime.
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ── Input schema ─────────────────────────────────────────────────────────────

const WorkspaceBudgetSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  enabled: z.boolean(),
  // null clears the limit (only meaningful when enabled is false).
  limitUsd: z.number().positive().nullable(),
  mode: z.enum(["grace", "prompt", "enforce"]),
  graceOveragePct: z.number().min(0).max(10),
  enforcement: z.enum(["default", "ceiling"]),
});

export type WorkspaceBudgetInput = z.infer<typeof WorkspaceBudgetSchema>;

export type WorkspaceBudgetActionResult =
  | { ok: true }
  | { ok: false; error: string };

// ── Action ────────────────────────────────────────────────────────────────────

export async function updateWorkspaceBudgetAction(
  input: WorkspaceBudgetInput,
): Promise<WorkspaceBudgetActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = WorkspaceBudgetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    enabled,
    limitUsd,
    mode,
    graceOveragePct,
    enforcement,
  } = parsed.data;

  // Resolve org + workspace — notFound() on slug mismatch prevents cross-tenant writes.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // Assert the caller is an org member first (IDOR guard).
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      // Re-read the caller's workspace role server-side — never trust the
      // client. apps/app does not enforce IAM via invoke(), so this IS the gate
      // for a capability whose contract declares Owner/Admin-only authorization.
      const wsRoleRows = await withTenantDb((tx) =>
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
      );

      const wsRole = wsRoleRows[0]?.role ?? "";
      if (!["owner", "admin"].includes(wsRole.toLowerCase())) {
        return {
          ok: false,
          error:
            "Only workspace owners and admins can edit the workspace budget.",
        };
      }

      const ctx = {
        orgId: org.id,
        workspaceId: ws.id,
        userId: session.user.id,
        apiKeyId: null as string | null,
        requestId: crypto.randomUUID(),
        surface: "app" as const,
        messageId: null as string | null,
      };

      try {
        // { surface: "agent" } — the contract's `surfaces` is
        // ["api","mcp","agent"] and does not include "app".
        await invoke(
          "update_budget_policy",
          { enabled, limitUsd, mode, graceOveragePct, enforcement },
          ctx,
          { surface: "agent" },
        );
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to save workspace budget.";
        return { ok: false, error: message };
      }

      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.agentDefaults(routeCtx));

      return { ok: true };
    },
  );
}
