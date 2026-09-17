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
// One tab. Preferences, security and privacy were the other three account
// pages; their reads have no rev1 port and their writes have no contract that
// declares `app` (ADR-081), so they are absent rather than stubbed — a tab
// that cannot save is the thing this file exists to stop shipping.
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
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { updateProfile } from "./account-actions";
import { initials } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

type Outcome = "saved" | "invalid" | "denied" | "failed";

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
  const [displayName, setDisplayName] = useState(viewer.name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(viewer.avatarUrl ?? "");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

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
        setOutcome("saved");
        // The shell renders the same person: the top bar's user menu reads
        // `data.viewer`, resolved on the server from the session. Without this
        // the name and avatar in the chrome stay as they were — across
        // client-side navigation too, because the shell lives in the org
        // layout — until a full reload. A re-render of the server tree at the
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
              setDisplayName(e.target.value);
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
              setAvatarUrl(e.target.value);
            }}
          />
          <p className={hint}>{t("avatarHint")}</p>
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
        {outcome === "saved" ? (
          <p
            data-testid="account-saved"
            className="mr-auto text-xs text-muted-foreground"
          >
            {t("saved")}
          </p>
        ) : null}
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
