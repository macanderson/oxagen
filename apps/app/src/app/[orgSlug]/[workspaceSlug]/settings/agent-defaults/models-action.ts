"use server";
/**
 * models-action.ts — server action for Workspace → Settings → Models.
 *
 * Writes workspace-level model defaults via the `workspace.model.settings.write`
 * capability. Role-gated to workspace owners and admins; only org+workspace
 * context is accepted — never a raw direct DB update.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("update_model_settings", …) can resolve its handler. Without
// this, invoke() throws "No handler registered" at runtime (the type system
// can't catch a missing side-effect import). Mirrors the chat stream route.
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

const WorkspaceModelsSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  defaultTextTier: z.enum(["fast", "balanced", "precise"]).nullable(),
  defaultTextModel: z.string().min(1).nullable(),
  defaultImageModel: z.string().min(1).nullable(),
  defaultVideoModel: z.string().min(1).nullable(),
});

export type WorkspaceModelsInput = z.infer<typeof WorkspaceModelsSchema>;

export type WorkspaceModelsActionResult =
  | { ok: true }
  | { ok: false; error: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCapabilityContext(opts: {
  orgId: string;
  workspaceId: string;
  userId: string;
}) {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId,
    userId: opts.userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function updateWorkspaceModelsAction(
  input: WorkspaceModelsInput,
): Promise<WorkspaceModelsActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = WorkspaceModelsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    defaultTextTier,
    defaultTextModel,
    defaultImageModel,
    defaultVideoModel,
  } = parsed.data;

  // Resolve org + workspace — notFound() on slug mismatch prevents cross-tenant writes.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // Assert the caller is an org member first (IDOR guard).
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      // Re-read the caller's workspace role server-side — never trust the client flag.
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
          error: "Only workspace owners and admins can edit model defaults.",
        };
      }

      const ctx = buildCapabilityContext({
        orgId: org.id,
        workspaceId: ws.id,
        userId: session.user.id,
      });

      try {
        // invoke() goes through kernel.invoke() which enters its own
        // runInTenantScope — the outer scope here is belt-and-suspenders
        // for any direct withTenantDb calls in this action.
        await invoke(
          "update_model_settings",
          {
            defaultTextTier,
            defaultTextModel,
            defaultImageModel,
            defaultVideoModel,
          },
          ctx,
          { surface: "agent" },
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to save model defaults.";
        return { ok: false, error: message };
      }

      const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
      revalidatePath(workspace.settings.agentDefaults(routeCtx));

      return { ok: true };
    },
  );
}
