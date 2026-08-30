"use server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { avatarUrlSchema } from "@oxagen/oxagen/avatar";
import { withSystemDb, schema } from "@oxagen/database";
// tenancy: unscoped seam (auth.users is a global identity table managed by
// Better Auth with no org_id/workspace_id columns; RLS is not applied to it
// per spec §6.3; withSystemDb bypasses RLS deliberately)
import { getSessionOrRedirect } from "@/lib/session";

const ProfileSchema = z.object({
  displayName: z.string().min(1).max(120).trim(),
  // https URL or designed-avatar spec string — the canonical avatar validator.
  avatarUrl: avatarUrlSchema.optional().or(z.literal("")),
});

export type ProfileInput = z.infer<typeof ProfileSchema>;

export type ProfileActionResult = { ok: true } | { ok: false; error: string };

export async function updateProfileAction(
  input: ProfileInput,
): Promise<ProfileActionResult> {
  const session = await getSessionOrRedirect();
  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { displayName, avatarUrl } = parsed.data;

  await withSystemDb((tx) =>
    tx
      .update(schema.users)
      .set({
        displayName,
        avatarUrl: avatarUrl || null,
      })
      .where(eq(schema.users.id, session.user.id)),
  );

  revalidatePath("/account/profile");
  return { ok: true };
}
