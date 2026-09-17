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
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { updateProfile } from "./account-actions";
import { initials } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

type Outcome = "saved" | "invalid" | "denied" | "failed";

const fieldLabel =
  "mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const hint = "mt-1.5 text-xs text-muted-foreground";

export function AccountDialog({ data }: { data: ShellData }) {
  const { accountOpen, setAccountOpen } = useShellState();
  return (
    <Dialog.Root open={accountOpen} onOpenChange={setAccountOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          data-testid="account-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-app-panel-bg p-5 text-app-panel-fg shadow-xl outline-none"
        >
          <AccountForm data={data} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AccountForm({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account");
  const { setAccountOpen } = useShellState();
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
      <div className="mb-4 flex items-start justify-between gap-4">
        <Dialog.Title className="text-base font-semibold">
          {t("title")}
        </Dialog.Title>
        <Dialog.Close
          aria-label={t("close")}
          className="rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </Dialog.Close>
      </div>

      <div className="mb-5 flex items-center gap-3.5">
        {avatarUrl.startsWith("https://") ? (
          /* An arbitrary remote avatar cannot be in next.config's image
             allowlist, and this is a 52px chrome ornament, not page content
             worth optimising. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="size-13 flex-none rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="grid size-13 flex-none place-items-center rounded-full bg-secondary text-base font-semibold text-secondary-foreground"
          >
            {initials(shown)}
          </span>
        )}
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
          <p data-testid="account-saved" className="mr-auto text-xs text-muted-foreground">
            {t("saved")}
          </p>
        ) : null}
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            setAccountOpen(false);
          }}
        >
          {t("close")}
        </button>
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
