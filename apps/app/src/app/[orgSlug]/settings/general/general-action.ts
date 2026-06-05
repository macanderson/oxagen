"use server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const OrgGeneralSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  avatarUrl: z.string().url().max(2048).optional().or(z.literal("")),
});

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type OrgGeneralActionResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Action
//
// orgSlug is bound by the server component (`.bind(null, orgSlug)`) so that
// the client only passes FormData — mirroring the profile-action pattern.
// ---------------------------------------------------------------------------

export async function updateOrgGeneralAction(
  orgSlug: string,
  formData: FormData,
): Promise<OrgGeneralActionResult> {
  try {
    // 1. Authenticate — session is required on every server action.
    const session = await getSessionOrRedirect();

    // 2. Re-resolve org from the slug (never trust client-provided IDs).
    const org = await resolveOrg(orgSlug);

    // 3. Assert membership first (IDOR guard); resolveOrg + assertOrgMember
    //    both call notFound() on failure, so we return early only for the
    //    role check below.
    await assertOrgMember(org.id, session.user.id);

    // 4. Re-read the caller's role from the DB server-side — never trust the
    //    client-side `canEdit` flag.
    const roleRows = await db()
      .select({ role: schema.orgUsers.role })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, org.id),
          eq(schema.orgUsers.userId, session.user.id),
        ),
      )
      .limit(1);

    const role = roleRows[0]?.role ?? "";
    if (!["owner", "admin"].includes(role.toLowerCase())) {
      return { ok: false, error: "Forbidden" };
    }

    // 5. Validate inputs.
    const raw = {
      name: formData.get("name"),
      avatarUrl: formData.get("avatarUrl") ?? undefined,
    };
    const parsed = OrgGeneralSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }

    const { name, avatarUrl } = parsed.data;

    // 6. Persist the update.
    await db()
      .update(schema.organizations)
      .set({
        name,
        avatarUrl: avatarUrl || null,
        updatedByUserId: session.user.id,
      })
      .where(eq(schema.organizations.id, org.id));

    // 7. Invalidate the settings page so a refresh shows the latest values.
    revalidatePath(`/${orgSlug}/settings/general`);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "An unexpected error occurred";
    return { ok: false, error: message };
  }
}
