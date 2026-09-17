// update_profile: the Account dialog's identity fields (display name, avatar).
// `auth.users` is a global identity table with no org_id/workspace_id and is
// not under RLS — same reasoning the retired `apps/app_deprecated` profile
// action carried, and the same reasoning `set_preferences` uses for
// `auth.user_preferences` — so withSystemDb is the right executor. The acting
// user id comes from the capability context principal, never from input: the
// contract deliberately has no user-id field, so there is no way to target
// anyone but the caller.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { userProfileUpdate } from "@oxagen/oxagen/contracts/user.profile.update";
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";

export const userProfileUpdateHandler: CapabilityHandler<
  typeof userProfileUpdate
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  const userId = ctx.userId;

  const row = await withSystemDb(async (tx) => {
    const [after] = await tx
      .update(schema.users)
      .set({
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        updatedAt: new Date(),
        updatedById: userId,
      })
      .where(eq(schema.users.id, userId))
      .returning({
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
      });
    return after;
  });
  if (!row) {
    throw new HandlerError({ code: "not_found", reason: "user_row_missing" });
  }

  return {
    displayName: row.displayName ?? input.displayName,
    avatarUrl: row.avatarUrl ?? null,
  };
};
