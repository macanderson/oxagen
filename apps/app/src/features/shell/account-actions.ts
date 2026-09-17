"use server";
// The one write behind the Account dialog: a person's own display name and
// avatar (spec App. F, "the account pages collapse into one Account dialog
// reachable from the user menu").
//
// It goes through the kernel seam like every other write in this app, and for
// a reason worth stating. The deprecated app wrote `auth.users` straight from
// a server action (`apps/app_deprecated/src/app/account/profile/profile-action.ts`),
// so a person's name and avatar were never a capability: no contract, no
// `layers[]`, no IAM check, no audit row. That is why nobody noticed when the
// surface disappeared at the cutover — `check:ui-parity` can only miss a page
// for a capability that promised one, and this one never did. `update_profile`
// makes the write a capability, which puts it back under the gates.
//
// The contract carries no user id and neither does this action: the handler
// acts on the authenticated principal. A profile write that took a target id
// would be a privilege-escalation surface reachable from a form field.
import { userProfileUpdate } from "@oxagen/oxagen/contracts/user.profile.update";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type ProfileDraft = {
  displayName: string;
  /**
   * An https URL or a designed-avatar spec string, per the canonical
   * `avatarUrlSchema`; empty clears the avatar. Not validated here —
   * `kernelWrite` pre-parses with the contract's own schema and answers
   * `invalid` with the offending field before the kernel runs (§3.2 step 5).
   */
  avatarUrl: string;
};

export type ProfileWritten = {
  displayName: string;
  avatarUrl: string | null;
};

/**
 * Change the signed-in person's display name and avatar.
 *
 * `org` names the viewer the URL is under, nothing more: the capability is
 * `scoped: false`, because `auth.users` is a global identity table with no
 * org_id or workspace_id and is not under RLS. The viewer is resolved so the
 * write runs as an admitted principal, not so the profile belongs to an org.
 */
export async function updateProfile(
  org: string,
  draft: ProfileDraft,
): Promise<ActionResult<ProfileWritten>> {
  const ctx = await requireViewer(org);
  return kernelWrite(ctx, userProfileUpdate, {
    displayName: draft.displayName,
    avatarUrl: draft.avatarUrl === "" ? null : draft.avatarUrl,
  });
}
