"use server";

import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";

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
});

type UpdateInput = z.infer<typeof UpdateWorkspaceGeneralSchema>;

export type UpdateWorkspaceGeneralResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Action
//
// Writes `workspaces.name` and stores `description` in the JSONB
// `workspaces.settings` column (no dedicated column required — the settings
// JSONB is the correct home for arbitrary workspace metadata that does not
// need to be indexed).
//
// Scoped to the authenticated user's org + workspace; resolveWorkspace calls
// notFound() if the workspace does not belong to the org, preventing
// cross-tenant writes.
// ---------------------------------------------------------------------------

export async function updateWorkspaceGeneralAction(
  input: UpdateInput,
): Promise<UpdateWorkspaceGeneralResult> {
  await getSessionOrRedirect();

  const parsed = UpdateWorkspaceGeneralSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { orgSlug, workspaceSlug, name, slug, description } = parsed.data;

  // Resolve org + workspace — notFound() on mismatch prevents cross-tenant writes.
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  // Guard the per-org slug uniqueness before writing so we can return a clean
  // error instead of surfacing a raw unique-constraint violation. Only check
  // when the slug actually changed.
  if (slug !== workspaceSlug) {
    const conflict = await db()
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, org.id),
          eq(schema.workspaces.slug, slug),
        ),
      )
      .limit(1);
    if (conflict.length > 0) {
      return { ok: false, error: "That slug is already taken in this organization." };
    }
  }

  // Merge description into the JSONB settings column. We use a Postgres
  // JSONB concatenation (`||`) to preserve existing keys while updating
  // only the 'description' key. The coalesce guards against NULL settings
  // (the schema defaults to '{}', but defensive code never hurts).
  const descriptionValue = description ?? "";
  const newSettings = sql`
    coalesce(${schema.workspaces.settings}, '{}'::jsonb)
    || jsonb_build_object('description', ${descriptionValue}::text)
  `;

  await db()
    .update(schema.workspaces)
    .set({
      name,
      slug,
      settings: newSettings,
    })
    .where(
      and(
        eq(schema.workspaces.id, ws.id),
        eq(schema.workspaces.orgId, org.id),
      ),
    );

  // Revalidate both the old and (if changed) the new slug paths so the cache
  // is correct regardless of which URL the client lands on next.
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings/general`);
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  if (slug !== workspaceSlug) {
    revalidatePath(`/${orgSlug}/${slug}/settings/general`);
    revalidatePath(`/${orgSlug}/${slug}/settings`);
  }

  return { ok: true, slug };
}
