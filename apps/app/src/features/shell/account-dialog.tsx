"use client";
// The Account dialog (spec App. F: the account pages collapse into one dialog
// reachable from the user menu; it is a dialog, not a page).
//
// The dialog WL-06 deleted was read-only by construction — its own header said
// "Reads only ... no control here pretends to save", and every input carried
// `readOnly`. This one saves, because a panel that shows a person their own
// name and cannot change it is not the surface the account pages were folded
// into. It writes through `update_profile` (features/shell/account-actions.ts),
// which is why the write is a capability at all.
//
// One tab. Of the preferences page, the time zone is here, because every date
// the app renders reads in it (features/shell/viewer-clock.tsx) and a clock
// nobody can set is a clock that is wrong for most of the world; it writes
// through `set_preferences`. Security and privacy, and the rest of the
// preferences, have no rev1 read and no contract that declares `app`
// (ADR-081), so they are absent rather than stubbed — a control that cannot
// save is the thing this file exists to stop shipping.
//
// It is a `SheetDialog` like every other dialog in the app, so on a phone it
// rises from the bottom edge with a drag handle, a scrim, safe-area padding
// and a full-width footer button (ARCHITECTURE.md §1.2, the phone shell;
// src/ui/phone.css). A hand-rolled `Dialog.Popup` here would be a centred
// desktop modal at every width.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import { Avatar } from "@/ui/avatar";
import { inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { timeZoneChoices } from "@/shared/time-zone";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { updateProfile, updateTimeZone } from "./account-actions";
import { initials } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

type Outcome =
  | "saved"
  | "invalid"
  | "timeZoneInvalid"
  | "denied"
  | "failed";

const fieldLabel =
  "mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const hint = "mt-1.5 text-xs text-muted-foreground";

export function AccountDialog({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account");
  const { accountOpen, setAccountOpen } = useShellState();
  return (
    <SheetDialog
      open={accountOpen}
      onOpenChange={setAccountOpen}
      title={t("title")}
      testId="account-dialog"
    >
      <AccountForm data={data} />
    </SheetDialog>
  );
}

function AccountForm({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account");
  const navigate = useNavigate();
  const { viewer, org } = data;
  const nameId = useId();
  const emailId = useId();
  const avatarId = useId();
  const timeZoneId = useId();
  const [displayName, setDisplayName] = useState(viewer.name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(viewer.avatarUrl ?? "");
  const [timeZone, setTimeZone] = useState(viewer.timeZone);
  // What the server holds, so an unchanged zone is not written on every save.
  const [storedTimeZone, setStoredTimeZone] = useState(viewer.timeZone);
  const [zones] = useState(() => timeZoneChoices(viewer.timeZone));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * "Saved." describes the draft that was submitted, so the first edit after a
   * save makes it false: the fields in front of the person now hold changes
   * that are not persisted, under a line claiming they are. A refusal is left
   * standing on purpose — it says what to fix, and it is still true while the
   * person is fixing it.
   */
  function editDraft(apply: () => void) {
    if (outcome === "saved") setOutcome(null);
    apply();
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setOutcome(null);
    setPending(true);
    try {
      const result = await updateProfile(org.slug, { displayName, avatarUrl });
      if (result.ok) {
        setDisplayName(result.value.displayName);
        setAvatarUrl(result.value.avatarUrl ?? "");
        // Two capabilities, one Save. The zone is written second and only when
        // it moved, so a name change never touches the preference row and a
        // refused zone leaves the profile saved, which the line below says.
        if (timeZone !== storedTimeZone) {
          const clock = await updateTimeZone(org.slug, timeZone);
          if (!clock.ok) {
            setOutcome(
              clock.reason === "invalid"
                ? "timeZoneInvalid"
                : clock.reason === "denied"
                  ? "denied"
                  : "failed",
            );
            return;
          }
          setTimeZone(clock.value.timeZone);
          setStoredTimeZone(clock.value.timeZone);
        }
        setOutcome("saved");
        // The shell renders the same person: the top bar's user menu reads
        // `data.viewer`, resolved on the server from the session. Without this
        // the name and avatar in the chrome stay as they were — across
        // client-side navigation too, because the shell lives in the org
        // layout — until a full reload. The same refresh carries a new zone
        // into <ViewerClock> and the chrome's <TimeZoneProvider>, so every
        // date on the page reads in it. A re-render of the server tree at the
        // URL already showing, not a navigation: the dialog stays open.
        navigate.refresh();
      } else if (result.reason === "invalid") setOutcome("invalid");
      else if (result.reason === "denied") setOutcome("denied");
      else setOutcome("failed");
    } catch {
      setOutcome("failed");
    } finally {
      setPending(false);
    }
  }

  const shown = displayName.trim() === "" ? viewer.email : displayName;
  return (
    <form noValidate onSubmit={(e) => void onSubmit(e)}>
      <div className="mb-5 flex items-center gap-3.5">
        <Avatar
          value={avatarUrl === "" ? null : avatarUrl}
          initials={initials(shown)}
          size="preview"
          testId="account-avatar-preview"
        />
        <div className="min-w-0">
          <p className="text-base font-semibold">{shown}</p>
          <p className="truncate text-sm text-muted-foreground">
            {viewer.email}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor={nameId} className={fieldLabel}>
            {t("displayName")}
          </label>
          <input
            id={nameId}
            data-testid="account-display-name"
            className={inputBase}
            value={displayName}
            maxLength={120}
            onChange={(e) => {
              editDraft(() => {
                setDisplayName(e.target.value);
              });
            }}
          />
        </div>
        <div>
          <label htmlFor={avatarId} className={fieldLabel}>
            {t("avatar")}
          </label>
          <input
            id={avatarId}
            data-testid="account-avatar-url"
            className={inputBase}
            value={avatarUrl}
            placeholder={t("avatarPlaceholder")}
            onChange={(e) => {
              editDraft(() => {
                setAvatarUrl(e.target.value);
              });
            }}
          />
          <p className={hint}>{t("avatarHint")}</p>
        </div>
        <div>
          <label htmlFor={timeZoneId} className={fieldLabel}>
            {t("timeZone")}
          </label>
          <select
            id={timeZoneId}
            data-testid="account-time-zone"
            className={inputBase}
            value={timeZone}
            onChange={(e) => {
              editDraft(() => {
                setTimeZone(e.target.value);
              });
            }}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className={hint}>{t("timeZoneHint")}</p>
        </div>
        <div>
          <label htmlFor={emailId} className={fieldLabel}>
            {t("email")}
          </label>
          <input
            id={emailId}
            type="email"
            className={inputBase}
            value={viewer.email}
            readOnly
            disabled
          />
          <p className={hint}>{t("emailHint")}</p>
        </div>
      </div>

      {outcome !== null && outcome !== "saved" ? (
        <div className="mt-4">
          <FormAlert testId={`account-${outcome}`}>{t(outcome)}</FormAlert>
        </div>
      ) : null}

      <div className="mt-5 flex items-center justify-end gap-2">
        {/* A refusal announces itself: FormAlert is role="alert", which is
            assertive and is read when it appears. Success was a plain <p>
            inserted next to a Save button that keeps focus, so a screen-reader
            user was told nothing at all — the one asymmetry between the two
            outcomes. The region is rendered on every pass rather than only on
            success, because a polite live region inserted at the same moment
            as its text is announced unreliably; it is the text arriving into a
            region already there that gets read. */}
        <p
          role="status"
          data-testid="account-status"
          className="mr-auto text-xs text-muted-foreground"
        >
          {outcome === "saved" ? (
            <span data-testid="account-saved">{t("saved")}</span>
          ) : null}
        </p>
        <SubmitButton
          pending={pending}
          fullWidth={false}
          label={t("save")}
          pendingLabel={t("saving")}
        />
      </div>
    </form>
  );
}
