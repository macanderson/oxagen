"use server";
// The two writes behind the Account dialog: a person's own display name and
// avatar (spec App. F, "the account pages collapse into one Account dialog
// reachable from the user menu"), and the time zone their dates render in.
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
import { userPreferencesSet } from "@oxagen/oxagen/contracts/user.preferences.set";
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

/**
 * Change the zone every date in the app renders in for the signed-in person.
 *
 * `set_preferences` is the one writer of `auth.user_preferences` (ADR-075) and
 * a partial write: only `timezone` is sent, so theme, locale and the model
 * defaults keep their stored values. The contract admits an IANA name; a value
 * outside that shape is answered `invalid` before the kernel runs. Like the
 * profile write it carries no user id: the handler acts on the principal.
 */
export async function updateTimeZone(
  org: string,
  timeZone: string,
): Promise<ActionResult<{ timeZone: string }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, userPreferencesSet, {
    timezone: timeZone,
  });
  return result.ok
    ? { ok: true, value: { timeZone: result.value.timezone } }
    : result;
}
