"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import { avatarUrlSchema } from "@oxagen/oxagen/avatar";
// Side-effect import: bind every foundation handler so invoke() can resolve.
import "@oxagen/handlers/register";
import type { WorkspaceSettingsWriteOutput } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const UpdateWorkspaceGeneralSchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  name: z.string().min(1).max(255),
  // Lowercase letters, digits, and single hyphens — no leading/trailing or
  // doubled hyphens. Mirrors the client-side slugify() output.
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase letters, numbers, and single hyphens",
    ),
  description: z.string().max(2000).optional(),
  // https URL or designed-avatar spec string — the canonical avatar validator.
  // Empty string means "clear the avatar" (normalized to null below).
  avatarUrl: avatarUrlSchema.optional().or(z.literal("")),
});

type UpdateInput = z.infer<typeof UpdateWorkspaceGeneralSchema>;

export type UpdateWorkspaceGeneralResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Action
//
// Routes the workspace general-settings save through the
// `workspace.settings.write` kernel capability — the SAME chokepoint reached
// from the in-app agent, MCP, and CLI — so the edit is metered, audited, and
// IAM-gated with zero surface drift. The handler writes name/slug/avatarUrl and
// the `description` column, read back by resolveWorkspace() so persistence is
// observable.
//
// Scoped to the authenticated user's org + workspace; resolveWorkspace calls
// notFound() if the workspace does not belong to the org, preventing
// cross-tenant writes. apps/app does NOT bootstrap IAM (invoke() in-app skips
// role checks), so we re-read the caller's workspace role server-side and
// reject non owner/admin before invoking — mirroring prompt-settings-action.
// ---------------------------------------------------------------------------

export async function updateWorkspaceGeneralAction(
  input: UpdateInput,
): Promise<UpdateWorkspaceGeneralResult> {
  const session = await getSessionOrRedirect();

  const parsed = UpdateWorkspaceGeneralSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { orgSlug, workspaceSlug, name, slug, description, avatarUrl } =
    parsed.data;

  // Resolve org + workspace — notFound() on mismatch prevents cross-tenant writes.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // Assert the caller is an org member first (IDOR guard).
  await assertOrgMember(org.id, session.user.id);

  return await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      // Re-read the caller's workspace role server-side — never trust the client.
      // apps/app does not enforce IAM via invoke(), so this is the gate.
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
            "Only workspace owners and admins can edit workspace settings.",
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
        // CRITICAL: pass { surface: "agent" } — the contract's `surfaces` list is
        // ["api","mcp","agent"] and does NOT include "app"; passing "app" throws
        // surface_denied. (Same as the prompt.settings.write precedent.)
        // Normalize empty/omitted description to null so the handler clears the
        // description column (rather than persisting an empty string).
        const descriptionValue =
          description === undefined || description === "" ? null : description;

        // Same normalization for the avatar: empty string clears the column.
        const avatarValue =
          avatarUrl === undefined || avatarUrl === "" ? null : avatarUrl;

        const result = (await invoke(
          "update_workspace_settings",
          { name, slug, description: descriptionValue, avatarUrl: avatarValue },
          ctx,
          { surface: "agent" },
        )) as WorkspaceSettingsWriteOutput;

        // Revalidate both the old and (if changed) the new slug paths so the cache
        // is correct regardless of which URL the client lands on next.
        revalidatePath(`/${orgSlug}/${workspaceSlug}/settings/general`);
        revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
        if (result.slug !== workspaceSlug) {
          revalidatePath(`/${orgSlug}/${result.slug}/settings/general`);
          revalidatePath(`/${orgSlug}/${result.slug}/settings`);
        }

        return { ok: true, slug: result.slug };
      } catch (err) {
        // Map the handler's slug-conflict error to the existing UX copy so the
        // form (and its tests) keep their stable message.
        const message = err instanceof Error ? err.message : "";
        if (message.toLowerCase().includes("already in use")) {
          return {
            ok: false,
            error: "That slug is already taken in this organization.",
          };
        }
        return {
          ok: false,
          error: message || "Failed to save workspace settings.",
        };
      }
    },
  );
}
