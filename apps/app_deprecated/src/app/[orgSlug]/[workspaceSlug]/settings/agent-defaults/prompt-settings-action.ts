"use server";
/**
 * prompt-settings-action.ts — server action for Workspace → Settings → Prompts.
 *
 * Writes workspace-level prompt settings via the `prompt.settings.write`
 * capability. Role-gated to workspace owners and admins. Mirrors the IAM
 * pattern from models-action.ts exactly.
 *
 * `overrides` (full prompt replacement) is enterprise-only and the capability
 * handler throws TierDeniedError for lower tiers — we surface a typed error
 * result so the form can show an upsell hint.
 */
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import type { PromptSettingsWriteOutput } from "@oxagen/oxagen/contracts/prompt.settings.write";

// Re-export for page.tsx
export type { PromptSettingsWriteOutput } from "@oxagen/oxagen/contracts/prompt.settings.write";
export type { PromptSettingsReadOutput } from "@oxagen/oxagen/contracts/prompt.settings.read";

// ── Input schema ─────────────────────────────────────────────────────────────

const promptOverridesSchema = z
  .object({
    "conversation.title": z.string().min(1).max(4000).optional(),
    "svg.generate": z.string().min(1).max(4000).optional(),
    "image.analyze": z.string().min(1).max(4000).optional(),
  })
  .partial();

const PromptSettingsSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  additionalInstructions: z.string().max(8000).nullable(),
  overrides: promptOverridesSchema.nullable().optional(),
  autoImprovePrompts: z.boolean(),
});

export type PromptSettingsInput = z.infer<typeof PromptSettingsSchema>;

export type PromptSettingsActionResult =
  | { ok: true; data: PromptSettingsWriteOutput }
  | { ok: false; error: string; tierDenied?: boolean };

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

export async function updatePromptSettingsAction(
  input: PromptSettingsInput,
): Promise<PromptSettingsActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = PromptSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const {
    orgSlug,
    workspaceSlug,
    additionalInstructions,
    overrides,
    autoImprovePrompts,
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
          error: "Only workspace owners and admins can edit prompt settings.",
        };
      }

      const ctx = buildCapabilityContext({
        orgId: org.id,
        workspaceId: ws.id,
        userId: session.user.id,
      });

      try {
        const result = (await invoke(
          "update_prompt_settings",
          { additionalInstructions, overrides, autoImprovePrompts },
          ctx,
          { surface: "agent" },
        )) as PromptSettingsWriteOutput;

        const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
        revalidatePath(workspace.settings.agentDefaults(routeCtx));

        return { ok: true, data: result };
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to save prompt settings.";
        // Surface a specific flag for enterprise-gate errors so the form can show an upsell.
        const isTierErr =
          err instanceof Error &&
          ("code" in err
            ? (err as Error & { code: unknown }).code === "TIER_DENIED"
            : err.message.toLowerCase().includes("tier"));
        return { ok: false, error: message, tierDenied: isTierErr };
      }
    },
  );
}
