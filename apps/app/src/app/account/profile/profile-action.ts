"use server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";

const ProfileSchema = z.object({
  displayName: z.string().min(1).max(120).trim(),
  avatarUrl: z.string().url().max(2048).optional().or(z.literal("")),
});

export type ProfileInput = z.infer<typeof ProfileSchema>;

export type ProfileActionResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateProfileAction(
  input: ProfileInput,
): Promise<ProfileActionResult> {
  const session = await getSessionOrRedirect();
  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { displayName, avatarUrl } = parsed.data;

  await db()
    .update(schema.users)
    .set({
      displayName,
      avatarUrl: avatarUrl || null,
    })
    .where(eq(schema.users.id, session.user.id));

  revalidatePath("/account/profile");
  return { ok: true };
}
