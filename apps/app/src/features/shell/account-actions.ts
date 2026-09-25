"use server";
// The two writes behind the Account dialog: a person's own display name and
// avatar (spec App. F, "the account pages collapse into one Account dialog
// reachable from the user menu"), and their preferences: the time zone their
// dates render in, and whether Enter sends in the assistant composer.
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
import { privacyDataExport } from "@oxagen/oxagen/contracts/privacy.data.export";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { userPreferencesRead } from "@oxagen/oxagen/contracts/user.preferences.read";
import { userPreferencesSet } from "@oxagen/oxagen/contracts/user.preferences.set";
import { userProfileUpdate } from "@oxagen/oxagen/contracts/user.profile.update";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type ProfileDraft = {
  /** Left out to change the avatar alone. */
  displayName?: string;
  /**
   * Left out to change the name alone, which is what the Profile form does:
   * sending the avatar it rendered with would revert a newer one saved since
   * (in the editor, or in another tab), because the handler writes every
   * is given.
   *
   * When present: an https URL or a designed-avatar spec string, per the
   * canonical `avatarUrlSchema`; empty clears the avatar. Not validated here
   * `kernelWrite` pre-parses with the contract's own schema and answers
   * `invalid` with the offending field before the kernel runs (§3.2 step 5).
   */
  avatarUrl?: string;
};

export type ProfileWritten = {
  displayName: string | null;
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
    ...(draft.displayName === undefined
      ? {}
      : { displayName: draft.displayName }),
    ...(draft.avatarUrl === undefined
      ? {}
      : { avatarUrl: draft.avatarUrl === "" ? null : draft.avatarUrl }),
  });
}

/**
 * The Preferences tab's four fields. `get_user_preferences` answers with the
 * whole set; the tab shows the ones it can set, and a partial `set_preferences`
 * leaves the rest as they are.
 */
export type PreferencesDraft = {
  /** A BCP 47 tag from the app's own catalog (`language` on the read). */
  locale: string;
  /** An IANA zone name. */
  timezone: string;
  theme: "system" | "light" | "dark";
  /** `enter_to_submit` (ADR-075): whether Enter sends in the assistant composer. */
  enterToSubmit: boolean;
};

/** INV-19: a `"use server"` module answers with an ActionResult, so a read's refusal takes a write's shape. */
export async function readPreferences(
  org: string,
): Promise<ActionResult<PreferencesDraft>> {
  const ctx = await requireViewer(org);
  const read = await kernelRead(ctx, {
    contract: userPreferencesRead,
    input: {},
    page: "shell",
  });
  if (!read.ok) return readToActionResult(read);
  const { language, timezone, theme, enterToSubmit } = read.value;
  return {
    ok: true,
    value: { locale: language, timezone, theme, enterToSubmit },
  };
}

export async function savePreferences(
  org: string,
  draft: PreferencesDraft,
): Promise<ActionResult<PreferencesDraft>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, userPreferencesSet, {
    locale: draft.locale,
    timezone: draft.timezone,
    theme: draft.theme,
    enterToSubmit: draft.enterToSubmit,
  });
  if (!result.ok) return result;
  const { locale, timezone, theme, enterToSubmit } = result.value;
  return { ok: true, value: { locale, timezone, theme, enterToSubmit } };
}

export type ExportQueued = { exportId: string; status: string };

/**
 * `export_data`: a bundle of the person's own activity, or of the whole
 * organization for an Owner or Admin. It queues and answers at once with the
 * export id; the bundle is fetched from the API by that id once it is ready
 * (packages/inngest-functions/src/functions/privacy.export.process.ts).
 */
export async function requestExport(
  org: string,
  scope: "user" | "org",
): Promise<ActionResult<ExportQueued>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, privacyDataExport, {
    scope,
    ...(scope === "org" ? { orgId: ctx.orgId } : {}),
  });
  return result.ok
    ? {
        ok: true,
        value: { exportId: result.value.exportId, status: result.value.status },
      }
    : result;
}

export type ExportProgress = {
  exportId: string;
  status: "queued" | "processing" | "ready" | "failed";
  /** Whether the bundle exists and can be fetched. */
  ready: boolean;
  /**
   * The canonical storage key, for the download route to stream back. The
   * archive is a private object, so there is no URL a browser could fetch.
   */
  storageKey: string | null;
};

/**
 * `get_export_status`: where a queued bundle has got to, and the link once it
 * is ready. `export_data` answers the instant it queues, so without this read
 * the Privacy tab could start a bundle it could never hand over, and the
 * right the export exists to serve is receiving the data, not starting a job.
 */
export async function readExportStatus(
  org: string,
  exportId: string,
): Promise<ActionResult<ExportProgress>> {
  const ctx = await requireViewer(org);
  const read = await kernelRead(ctx, {
    contract: privacyDataExportStatus,
    input: { exportId },
    page: "shell",
  });
  if (!read.ok) return readToActionResult(read);
  const { status, ready, storageKey } = read.value;
  return { ok: true, value: { exportId, status, ready, storageKey } };
}
