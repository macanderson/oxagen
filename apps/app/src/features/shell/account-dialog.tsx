"use client";
// The Account dialog (spec App. F; mockup `accountBody`/`accountTabs`): the
// account pages collapse into one dialog reachable from the user menu, with
// four tabs: Profile, Preferences, Security, Privacy. The mockup's fifth tab
// is an onboarding demo and is not a product tab.
//
// Every control here saves or acts, and none is a stub: Profile writes
// `update_profile`; Preferences reads `get_user_preferences` and writes
// `set_preferences`, including the time zone every date in the app renders in
// (features/shell/viewer-clock.tsx); Security lists and revokes Better Auth
// sessions and reissues recovery codes; Privacy queues `export_data`. What the
// product cannot do yet is absent, not drawn: a control that cannot act is the
// thing this file exists to stop shipping.
//
// It is a `SheetDialog` like every other dialog in the app, so on a phone it
// rises from the bottom edge with a drag handle, a scrim, safe-area padding
// and a full-width footer button (ARCHITECTURE.md §1.2, the phone shell;
// src/ui/phone.css).
import { KeyRound, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  type Dispatch,
  type SetStateAction,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { routes } from "@/shared/safe-path";
import { useFormatter } from "@/ui/formatter";
import { timeZoneChoices } from "@/shared/time-zone";
import { Avatar } from "@/ui/avatar";
import { buttonPrimary, inputBase, panel } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { formatCount, formatMoney } from "@/ui/money-format";
import { DownloadLink, SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog, SheetFooterAction } from "@/ui/sheet-dialog";
import {
  type PreferencesDraft,
  readPreferences,
  readExportStatus,
  requestExport,
  savePreferences,
  updateProfile,
} from "./account-actions";
import {
  buttonSmall,
  fieldLabel,
  hint,
  kv,
  kvTerm,
  kvValue,
  list,
  listBody,
  listIcon,
  listRow,
  listText,
  listTime,
  listTitle,
} from "./account-styles";
import { initials } from "./format";
import { recoveryCodeVault, useRecoveryCodeVault } from "./recovery-code-vault";
import { useAccountOperation, useAccountExport } from "./account-operations";
import {
  liveListSessions,
  liveRegenerateBackupCodes,
  liveRevokeSession,
  type LiveSession,
} from "./session-client";
import type { ShellData } from "./shell-data";
import { ACCOUNT_TABS, type AccountTab, useShellState } from "./shell-state";
import type { Theme } from "./theme";

// No `timeZoneInvalid`: on main the Profile tab wrote the zone itself through
// `updateTimeZone` and had to report a refusal from that second write. Here the
// zone belongs to Preferences, which reports its own outcome, and Profile calls
// `updateTimeZone` nowhere — so the member would be a state nothing can reach.
type Outcome = "saved" | "invalid" | "denied" | "failed";

const tabClass =
  "inline-flex min-h-10 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:border-brand aria-selected:text-foreground";

type ProfileDraft = { userId: string; value: string };
type ProfileDraftProps = {
  profileDraft: ProfileDraft | null;
  setProfileDraft: Dispatch<SetStateAction<ProfileDraft | null>>;
};

export function AccountDialog({ data }: { data: ShellData }) {
  const [profileDraft, setProfileDraft] = useState<ProfileDraft | null>(null);
  const t = useTranslations("shell.account");
  const {
    accountOpen,
    setAccountOpen,
    accountTab,
    setAccountTab,
    openAccount,
  } = useShellState();

  // Recovery codes are shown exactly once, and from the moment a rotation
  // lands on the server this page holds the only copy that will ever exist.
  // They are held in `recovery-code-vault.ts`, not here and not in the
  // Security tab, because both of those are unmounted by routine things: the
  // tab by a tab switch or a close, and this dialog by any client-side
  // transition out of the organization, Back and Forward included. The vault
  // lives as long as the page does, arms the browser's unload prompt while
  // anything is at stake, and is cleared only when the person says the set is
  // saved, which is the one signal that the single showing was received.
  //
  // The review that first found the reload case asked for the pending set to
  // be held in server-backed state until it is acknowledged. That is the
  // wrong trade, and deliberately not what this does. It would put a full
  // second factor bypass in Oxagen's own database in recoverable form, for as
  // long as nobody presses a button, replicated to whichever data plane the
  // organisation is on (ADR-042), in its backups, and inside the very export
  // bundle this dialog queues. Losing an unsaved set to a reload costs one more
  // rotation, with the password, by someone who is signed in and still holds
  // the authenticator that got them here. Storing the codes costs the factor
  // itself, to anyone who reaches the row. The cheaper failure is the one to
  // keep, and the reload is asked about first.
  const userId = data.viewer.id;
  const vault = useRecoveryCodeVault(userId);
  const heldCodes = vault.codes;
  const codesNeedAttention = vault.rotating || heldCodes !== null;
  const setHeldCodes = useCallback(
    (codes: string[] | null) => {
      if (codes) recoveryCodeVault.hold(userId, codes);
      else recoveryCodeVault.clear();
    },
    [userId],
  );

  // One rotation at a time, held in the vault for the same reason the codes
  // are. A `pending` flag inside the tab is discarded by Cancel, a tab switch
  // or a close, and the next press would start a second rotation against a
  // server that has already voided one set. The two calls can then settle in
  // either order, and the loser's codes land after the winner's, so the set on
  // screen is one the later call already invalidated. Two rotations never
  // exist, which is why no response can ever be a superseded one.
  const rotation: CodeRotation = {
    pending: vault.rotating,
    uncertain: vault.uncertain,
    begin: () => recoveryCodeVault.begin(userId),
    heldByAnother: () => recoveryCodeVault.heldByAnother(userId),
    claimAcrossTabs: () => recoveryCodeVault.claimAcrossTabs(),
    end: () => {
      recoveryCodeVault.end();
    },
    refuse: () => {
      recoveryCodeVault.refuse();
    },
    lose: () => {
      recoveryCodeVault.lose(userId);
    },
  };

  // Arriving in a shell with codes already at stake means the person left the
  // organization they rotated in, by Back or by a link, before saving them.
  // The set is still in the vault, so it is put back in front of them rather
  // than left for them to go looking for.
  const arrivedWithCodesRef = useRef(
    vault.rotating || vault.codes !== null || vault.uncertain,
  );
  useEffect(() => {
    if (arrivedWithCodesRef.current) openAccount("security");
  }, [openAccount]);

  // The ARIA tabs pattern, because `role="tab"` is a promise about the
  // keyboard. A screen-reader user told a control is a tab expects Left and
  // Right to move between them and Home and End to reach the ends, and expects
  // one Tab press to leave the strip rather than four. Without this the role
  // describes something the widget does not do, which is worse than no role.
  //
  // Selection follows focus (automatic activation), which APG prefers where a
  // panel is cheap to render. These four are: each is a form over data the
  // dialog already holds.
  const tabRef = useRef(new Map<AccountTab, HTMLButtonElement | null>());
  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    if (codesNeedAttention) return;
    const last = ACCOUNT_TABS.length - 1;
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % ACCOUNT_TABS.length
        : event.key === "ArrowLeft"
          ? (index + last) % ACCOUNT_TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (target === null) return;
    const next = ACCOUNT_TABS[target];
    if (!next) return;
    // Left and Right are the tablist's, not the page's: without this the
    // horizontally scrolling strip also scrolls under the arrow key.
    event.preventDefault();
    setAccountTab(next);
    tabRef.current.get(next)?.focus();
  };

  return (
    <SheetDialog
      open={accountOpen}
      onOpenChange={(open) => {
        if (!open) setProfileDraft(null);
        setAccountOpen(open);
      }}
      title={t("title")}
      dismissible={!codesNeedAttention}
      testId="account-dialog"
      wide
      tabs={
        <div
          role="tablist"
          aria-label={t("title")}
          className="-mb-px flex gap-0.5 overflow-x-auto border-b border-border"
        >
          {ACCOUNT_TABS.map((tab, index) => (
            <button
              key={tab}
              ref={(node) => {
                tabRef.current.set(tab, node);
              }}
              type="button"
              role="tab"
              disabled={codesNeedAttention}
              id={`account-tab-${tab}`}
              data-testid={`account-tab-${tab}`}
              aria-selected={accountTab === tab}
              aria-controls={`account-panel-${tab}`}
              // Roving: the strip is one stop in the page's Tab order, and Tab
              // from it goes to the panel rather than to the next tab.
              tabIndex={accountTab === tab ? 0 : -1}
              className={tabClass}
              onClick={() => {
                setAccountTab(tab);
              }}
              onKeyDown={(event) => {
                onTabKeyDown(event, index);
              }}
            >
              {t(`tabs.${tab}`)}
            </button>
          ))}
        </div>
      }
    >
      {accountOpen ? (
        <div
          role="tabpanel"
          id={`account-panel-${accountTab}`}
          aria-labelledby={`account-tab-${accountTab}`}
        >
          <AccountPanel
            key={accountTab}
            tab={accountTab}
            data={data}
            profileDraft={profileDraft}
            setProfileDraft={setProfileDraft}
            heldCodes={heldCodes}
            setHeldCodes={setHeldCodes}
            rotation={rotation}
          />
        </div>
      ) : null}
    </SheetDialog>
  );
}

/**
 * The one rotation in flight, held above every state the Security tab owns, so
 * that Cancel, a tab switch and a close cannot lose it and let a second start.
 *
 * `begin` claims the gate and answers false when a rotation is already running,
 * in which case this one must not start. `end` releases it once that rotation
 * has settled.
 */
type CodeRotation = {
  pending: boolean;
  /** An earlier rotation's answer was lost, so the stored set is unknown. */
  uncertain: boolean;
  begin: () => boolean;
  /**
   * Whether a refusal from `begin` is another person's held set rather than a
   * rotation already on the wire. The store outlives a sign-out and a sign-in
   * as somebody else in the same tab, and it will not overwrite their unsaved
   * codes.
   */
  heldByAnother: () => boolean;
  /** Claim the rotation across every tab of this browser; false if another holds it. */
  claimAcrossTabs: () => Promise<boolean>;
  end: () => void;
  /** The server answered and refused: this rotation changed nothing. */
  refuse: () => void;
  /** The call threw: the old set may be void and the new one is gone. */
  lose: () => void;
};

type CodeVault = {
  /** Codes issued and not yet acknowledged, held above the tab that shows them. */
  heldCodes: string[] | null;
  setHeldCodes: (codes: string[] | null) => void;
  rotation: CodeRotation;
};

function AccountPanel({
  profileDraft,
  setProfileDraft,
  tab,
  data,
  heldCodes,
  setHeldCodes,
  rotation,
}: { tab: AccountTab; data: ShellData } & CodeVault & ProfileDraftProps) {
  if (tab === "preferences") return <PreferencesTab data={data} />;
  if (tab === "security")
    return (
      <SecurityTab
        data={data}
        heldCodes={heldCodes}
        setHeldCodes={setHeldCodes}
        rotation={rotation}
      />
    );
  if (tab === "privacy") return <PrivacyTab data={data} />;
  return (
    <ProfileTab
      data={data}
      profileDraft={profileDraft}
      setProfileDraft={setProfileDraft}
    />
  );
}

/* ============================== Profile ============================== */

function ProfileTab({
  data,
  profileDraft,
  setProfileDraft,
}: { data: ShellData } & ProfileDraftProps) {
  const t = useTranslations("shell.account");
  const navigate = useNavigate();
  const { setAvatarOpen } = useShellState();
  const { viewer, org } = data;
  const nameId = useId();
  const emailId = useId();
  const displayName =
    profileDraft?.userId === viewer.id
      ? profileDraft.value
      : (viewer.name ?? "");
  const setDisplayName = (value: string) => {
    setProfileDraft({ userId: viewer.id, value });
  };
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const operation = useAccountOperation(data.viewer.id, "profile");
  const { pending } = operation;

  /**
   * Counts edits, so a save that lands late can tell whether the field it is
   * about to overwrite is still the field that was sent. See `onSubmit`.
   */
  const editsRef = useRef(0);

  /**
   * "Saved." describes the draft that was submitted, so the first edit after a
   * save makes it false: the field in front of the person now holds a change
   * that is not persisted, under a line claiming it is. A refusal is left
   * standing on purpose — it says what to fix, and it is still true while the
   * person is fixing it.
   */
  function editDraft(apply: () => void) {
    if (outcome === "saved") setOutcome(null);
    editsRef.current += 1;
    apply();
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operation.begin()) return;
    const sentAt = editsRef.current;
    setOutcome(null);
    try {
      // The name alone. `viewer.avatarUrl` is what the server rendered with,
      // so sending it back would revert an avatar saved since (in the
      // editor, or in another tab), because the handler writes every field
      // it is given.
      const result = await updateProfile(org.slug, { displayName });
      if (result.ok) {
        // Only if the field is still the one that was sent. A save is a round
        // trip, and typing does not stop while it is in flight: adopting the
        // server's echo unconditionally deletes every character entered since
        // the button was pressed, and then says "Saved." about the value it
        // just put back — the one claim the person has no reason to doubt and
        // every reason to act on. When the draft has moved on, the newer text
        // stands, and nothing claims it is saved, which is the truth.
        if (editsRef.current === sentAt) {
          setProfileDraft((current) =>
            current === profileDraft
              ? {
                  userId: viewer.id,
                  value: result.value.displayName ?? displayName,
                }
              : current,
          );
          setOutcome("saved");
        }
        // The shell renders the same person: the top bar's user menu reads
        // `data.viewer`, resolved on the server from the session. A re-render
        // of the server tree at the URL already showing, not a navigation:
        // the dialog stays open.
        navigate.refresh();
      } else if (result.reason === "invalid") setOutcome("invalid");
      else if (result.reason === "denied") setOutcome("denied");
      else setOutcome("failed");
    } catch {
      setOutcome("failed");
    } finally {
      operation.end();
    }
  }

  const shown = displayName.trim() === "" ? viewer.email : displayName;
  return (
    <form
      id="account-profile-form"
      noValidate
      onSubmit={(e) => void onSubmit(e)}
    >
      <SheetFooterAction>
        <SubmitButton
          pending={pending}
          fullWidth={false}
          label={t("save")}
          pendingLabel={t("saving")}
          form="account-profile-form"
          testId="account-save"
        />
      </SheetFooterAction>
      <div className="mb-4 flex items-center gap-3.5">
        <Avatar
          value={viewer.avatarUrl}
          initials={initials(shown)}
          size={52}
          testId="account-avatar-preview"
        />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{shown}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {viewer.email} ·{" "}
            {viewer.emailVerified ? t("verified") : t("unverified")}
          </p>
        </div>
        <button
          type="button"
          data-testid="edit-avatar"
          className={`${buttonSmall} ml-auto`}
          onClick={() => {
            setAvatarOpen(true);
          }}
        >
          {t("editAvatar")}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
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

      <div className="mt-4">
        <span className={fieldLabel}>{t("roles")}</span>
        <dl className={kv} data-testid="account-roles">
          <dt className={kvTerm}>{org.slug}</dt>
          <dd className={kvValue}>{t("orgRole", { role: viewer.orgRole })}</dd>
          {/* The Better Auth `auth.users.id`, and labelled as such. It read
              "principal · kind human", which named a different thing: a human
              IAM principal is its own `iam.principals` row linked by
              `parent_user_id`, so its id is not this one. Someone copying this
              value for IAM or audit work copied the wrong identifier under a
              label that said it was the right one. Showing the real principal
              id would need a read this shell does not make. */}
          <dt className={kvTerm}>{t("principal")}</dt>
          <dd className={kvValue}>{viewer.id}</dd>
        </dl>
        <p className={`${hint} mt-2.5`}>
          {t.rich("rolesHint", {
            code: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
        </p>
      </div>

      {outcome !== null && outcome !== "saved" ? (
        <div className="mt-4">
          <FormAlert testId={`account-${outcome}`}>{t(outcome)}</FormAlert>
        </div>
      ) : null}
      {/* A refusal announces itself: FormAlert is role="alert". Success needs
          its own live region, rendered on every pass so the text arriving
          into a region already there is what gets read. */}
      <p
        role="status"
        data-testid="account-status"
        className="mt-3 text-xs text-muted-foreground"
      >
        {outcome === "saved" ? (
          <span data-testid="account-saved">{t("saved")}</span>
        ) : null}
      </p>
    </form>
  );
}

/* ============================== Preferences ============================== */

type PrefsState =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "failed" }
  | { kind: "ready"; draft: PreferencesDraft };

const THEMES: readonly Theme[] = ["system", "dark", "light"];

/** The zones the browser knows, plus UTC, with the stored one kept even when it is not among them. */
function timeZones(current: string): string[] {
  let zones: readonly string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // An older engine lists nothing; UTC and the stored zone still appear.
  }
  // The engine's list does not contain UTC. Measured on this repo's Node: 418
  // zones, no "UTC" and no "Etc/UTC", because ICU canonicalizes those away.
  // UTC is a zone people work in and ask for by name, and the one this app
  // defaulted to before Pacific, so accounts still hold it. Offering the
  // engine's list alone would show it to nobody but the people already on it,
  // and anyone who moved away could never get back. Merged, not replaced.
  const offered = zones.includes("UTC") ? zones : ["UTC", ...zones];
  // Keeping the stored zone when the runtime does not name it is the shared
  // rule, so the select and the chrome's clock resolve a zone the same way
  // (src/shared/time-zone.ts).
  return timeZoneChoices(current, offered);
}

/** The same three figures under the draft's locale and zone, so a change is seen before it is saved. */
function previewFor(locale: string, timeZone: string) {
  const at = new Date();
  try {
    return {
      date: new Intl.DateTimeFormat(locale, {
        dateStyle: "long",
        timeStyle: "short",
        timeZone,
      }).format(at),
      number: formatCount(18472, locale),
      money: formatMoney(
        { currency: "USD", micros: "18472360000" },
        { locale, precision: "cents" },
      ),
    };
  } catch {
    return { date: at.toISOString(), number: "18472", money: "18472.36 USD" };
  }
}

function PreferencesTab({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account.preferences");
  const navigate = useNavigate();
  const { setTheme, previewTheme } = useShellState();
  const localeId = useId();
  const zoneId = useId();
  const themeId = useId();
  const [state, setState] = useState<PrefsState>({ kind: "loading" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const operation = useAccountOperation(data.viewer.id, "preferences");
  const { pending } = operation;
  /** Edit counter, for the same reason as the Profile tab's: see `onSubmit`. */
  const editsRef = useRef(0);

  useEffect(() => {
    let live = true;
    void readPreferences(data.org.slug)
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({ kind: "ready", draft: result.value });
          setTheme(result.value.theme);
        } else if (result.reason === "denied") setState({ kind: "denied" });
        else setState({ kind: "failed" });
      })
      .catch(() => {
        if (live) setState({ kind: "failed" });
      });
    return () => {
      live = false;
      previewTheme(null);
    };
  }, [data.org.slug, setTheme, previewTheme]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function edit(patch: Partial<PreferencesDraft>) {
    if (patch.theme !== undefined) previewTheme(patch.theme);
    if (outcome === "saved") setOutcome(null);
    editsRef.current += 1;
    setState((s) =>
      s.kind === "ready"
        ? { kind: "ready", draft: { ...s.draft, ...patch } }
        : s,
    );
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind !== "ready" || !operation.begin()) return;
    const sentAt = editsRef.current;
    setOutcome(null);
    try {
      const result = await savePreferences(data.org.slug, state.draft);
      if (result.ok) {
        setTheme(result.value.theme);
        if (mountedRef.current && editsRef.current === sentAt) previewTheme(null);
        // Only if the form is still the one that was sent, and for the same
        // reason as the Profile tab: a selection made while the save was in
        // flight is a decision the person has taken, and replacing it with the
        // older answer under a "Saved." line hides that it was thrown away.
        // Keep a newer theme preview while committing the saved value below it.
        if (editsRef.current === sentAt) {
          setState({ kind: "ready", draft: result.value });
          setOutcome("saved");
        }
        // The zone this row holds is the one every date in the app renders in:
        // the organization layout reads it server-side and hands it to
        // <ViewerClock> and the chrome's <TimeZoneProvider>. Without this the
        // stored zone changes and every date on the page keeps the zone the
        // request started in until a full reload, across client-side
        // navigation too, because the shell lives in the layout. Re-rendered
        // only when the zone actually moved, and at the URL already showing,
        // so the dialog stays open.
        if (result.value.timezone !== data.viewer.timeZone) navigate.refresh();
      } else {
        if (mountedRef.current) previewTheme(null);
        if (result.reason === "invalid") setOutcome("invalid");
        else if (result.reason === "denied") setOutcome("denied");
        else setOutcome("failed");
      }
    } catch {
      if (mountedRef.current) previewTheme(null);
      setOutcome("failed");
    } finally {
      operation.end();
    }
  }

  if (state.kind === "loading")
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("loading")}
      </p>
    );
  if (state.kind !== "ready")
    return (
      <FormAlert testId={`account-preferences-${state.kind}`}>
        {t(state.kind)}
      </FormAlert>
    );

  const { draft } = state;
  const preview = previewFor(draft.locale, draft.timezone);
  const locales = draft.locale === "en" ? ["en"] : [draft.locale, "en"];
  return (
    <form
      id="account-preferences-form"
      noValidate
      onSubmit={(e) => void onSubmit(e)}
    >
      <SheetFooterAction>
        <SubmitButton
          pending={pending}
          fullWidth={false}
          label={t("save")}
          pendingLabel={t("saving")}
          form="account-preferences-form"
          testId="account-preferences-save"
        />
      </SheetFooterAction>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={localeId} className={fieldLabel}>
            {t("locale")}
          </label>
          <select
            id={localeId}
            data-testid="account-locale"
            className={inputBase}
            value={draft.locale}
            onChange={(e) => {
              edit({ locale: e.target.value });
            }}
          >
            {locales.map((code) => (
              <option key={code} value={code}>
                {t("localeName", { code })}
              </option>
            ))}
          </select>
          <p className={hint}>{t("localeHint")}</p>
        </div>
        <div>
          <label htmlFor={zoneId} className={fieldLabel}>
            {t("timezone")}
          </label>
          <select
            id={zoneId}
            data-testid="account-timezone"
            className={inputBase}
            value={draft.timezone}
            onChange={(e) => {
              edit({ timezone: e.target.value });
            }}
          >
            {timeZones(draft.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className={hint}>{t("timezoneHint")}</p>
        </div>
        <div>
          <label htmlFor={themeId} className={fieldLabel}>
            {t("theme")}
          </label>
          <select
            id={themeId}
            data-testid="account-theme"
            className={inputBase}
            value={draft.theme}
            onChange={(e) => {
              const next = THEMES.find((v) => v === e.target.value) ?? "system";
              // The effect above follows the draft, so the page changes at
              // once without this handler applying it a second time.
              edit({ theme: next });
            }}
          >
            {THEMES.map((value) => (
              <option key={value} value={value}>
                {t(`themes.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4">
        <span className={fieldLabel}>{t("preview")}</span>
        <dl
          className={`${kv} ${panel} px-4 py-3.5`}
          data-testid="account-preview"
        >
          <dt className={kvTerm}>{t("previewDate")}</dt>
          <dd className={kvValue}>{preview.date}</dd>
          <dt className={kvTerm}>{t("previewNumber")}</dt>
          <dd className={kvValue}>{preview.number}</dd>
          <dt className={kvTerm}>{t("previewMoney")}</dt>
          <dd className={kvValue}>{preview.money}</dd>
        </dl>
      </div>

      {outcome !== null && outcome !== "saved" ? (
        <div className="mt-4">
          <FormAlert testId={`account-preferences-${outcome}`}>
            {t(outcome)}
          </FormAlert>
        </div>
      ) : null}
      <p
        role="status"
        data-testid="account-preferences-status"
        className="mt-3 text-xs text-muted-foreground"
      >
        {outcome === "saved" ? (
          <span data-testid="account-preferences-saved">{t("saved")}</span>
        ) : null}
      </p>
    </form>
  );
}

/* ============================== Security ============================== */

type SessionsState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; sessions: LiveSession[] };

// No `pending` here: whether a rotation is running is the dialog's, not this
// state's, because this state is thrown away by Cancel, by a tab switch and by
// a close while the rotation outlives all three.
type CodesState =
  | { kind: "closed" }
  | { kind: "asking"; password: string; refused: boolean }
  | { kind: "issued"; codes: string[] }
  /**
   * The rotation was refused before it started, because another person's
   * unsaved set is still held in this tab. The vault outlives a sign-out and a
   * sign-in as somebody else, and it will not overwrite their only copy.
   */
  | { kind: "blockedByOther" }
  /**
   * Refused before it started, because another tab of this browser has a
   * rotation running or a set unsaved. A second rotation would void that set
   * while the other tab still shows it as the one to keep.
   */
  | { kind: "blockedElsewhere" };

/** "MacBook Pro · Chrome 141" from a user agent, or the raw string when nothing is recognised. */
function describeAgent(userAgent: string | null, fallback: string): string {
  if (!userAgent) return fallback;
  const version = (pattern: RegExp): string | null => {
    const match = pattern.exec(userAgent);
    return match?.[1] === undefined ? null : match[1];
  };
  const edge = version(/Edg\/(\d+)/);
  const firefox = version(/Firefox\/(\d+)/);
  const chrome = version(/Chrome\/(\d+)/);
  const safari = version(/Version\/(\d+)[^ ]* .*Safari/);
  const browser =
    edge !== null
      ? `Edge ${edge}`
      : firefox !== null
        ? `Firefox ${firefox}`
        : chrome !== null
          ? `Chrome ${chrome}`
          : safari !== null
            ? `Safari ${safari}`
            : null;
  const device = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Macintosh/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  if (!browser && !device) return userAgent.slice(0, 60);
  return [device, browser].filter(Boolean).join(" · ");
}

function SecurityTab({
  data,
  heldCodes,
  setHeldCodes,
  rotation,
}: { data: ShellData } & CodeVault) {
  const t = useTranslations("shell.account.security");
  // The viewer's zone, not UTC. Preferences promises every date and time
  // follows the zone chosen there, and a device list that answers in UTC
  // breaks that promise where it matters most: "was that me?" is a question
  // about the clock the person was actually looking at.
  const format = useFormatter();
  const passwordId = useId();
  const [sessions, setSessions] = useState<SessionsState>({ kind: "loading" });
  // Seeded from the vault, so a return to this tab shows codes issued while
  // it was unmounted rather than an empty panel over a rotated secret. A
  // rotation still in flight is seeded too, so a remount mid-rotation shows the
  // form working rather than a Regenerate button that would refuse the press.
  const [codes, setCodes] = useState<CodesState>(() =>
    heldCodes
      ? { kind: "issued", codes: heldCodes }
      : rotation.pending || rotation.uncertain
        ? { kind: "asking", password: "", refused: false }
        : { kind: "closed" },
  );
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState<string | null>(null);

  // The rotation that fills the vault can belong to an earlier mount of this
  // tab: started here, left mid-flight, and returned to before it settled. That
  // mount's own `setCodes` went nowhere, and the seed above already ran, so the
  // vault filling is the only thing that can tell this mount the set arrived.
  // Without this the codes would sit in the vault behind a form still saying it
  // is issuing them.
  //
  // Adjusted during render rather than in an effect, which is React's own
  // answer for state that has to follow a value from above
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // An effect would render the stale form first and correct it on a second
  // pass, and `react-hooks/set-state-in-effect` refuses it for that reason.
  // React re-runs this component immediately, before anything is committed, so
  // the form never shows the wrong thing.
  const [vaulted, setVaulted] = useState(heldCodes);
  if (heldCodes !== vaulted) {
    setVaulted(heldCodes);
    if (heldCodes) setCodes({ kind: "issued", codes: heldCodes });
  }

  useEffect(() => {
    let live = true;
    void liveListSessions()
      .then((result) => {
        if (!live) return;
        setSessions(
          result.ok
            ? { kind: "ready", sessions: result.sessions }
            : { kind: "failed" },
        );
      })
      .catch(() => {
        if (live) setSessions({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, []);

  async function revoke(token: string) {
    if (revoking) return;
    setRevoking(token);
    setRevoked(false);
    setRevokeFailed(null);
    try {
      const ok = await liveRevokeSession(token);
      if (ok) {
        setSessions((s) =>
          s.kind === "ready"
            ? {
                kind: "ready",
                sessions: s.sessions.filter((x) => x.token !== token),
              }
            : s,
        );
        setRevoked(true);
      } else setRevokeFailed(token);
    } catch {
      setRevokeFailed(token);
    } finally {
      setRevoking(null);
    }
  }

  async function regenerate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (codes.kind !== "asking") return;
    // The gate, not a disabled button: the button is gone the moment the person
    // presses Cancel or leaves the tab, and the rotation is not.
    if (!rotation.begin()) {
      // Refused because somebody else's set is still unsaved in this tab, not
      // because a rotation is already running. Saying so beats a button that
      // does nothing, and a reload drops the store with the page.
      if (rotation.heldByAnother()) setCodes({ kind: "blockedByOther" });
      return;
    }
    const { password } = codes;
    setCodes({ kind: "asking", password, refused: false });
    // Then across tabs. Awaited before the request leaves, so a refused claim
    // sends nothing and changes nothing on the server.
    if (!(await rotation.claimAcrossTabs())) {
      rotation.end();
      setCodes({ kind: "blockedElsewhere" });
      return;
    }
    try {
      const result = await liveRegenerateBackupCodes(password);
      // No `rotation.end()` here: each branch below moves the vault straight
      // from rotating to what the answer means. Ending first would pass through
      // "nothing at stake" for an instant, which drops the unload prompt and
      // the cross-tab claim just before the lost-answer branch needs both.
      if (result.ok) {
        // The vault first, and deliberately: this component may already be
        // unmounted, in which case its own setState is a no-op and this write
        // to the still-mounted dialog is the only thing keeping the codes.
        setHeldCodes(result.codes);
        setCodes({ kind: "issued", codes: result.codes });
      } else if (result.refused) {
        // Better Auth answered and refused, a wrong password for one. It read
        // the request and declined it, so this rotation did not happen and the
        // stored set still works. Nothing is displayed: a set left on screen
        // would claim to be the stored set.
        rotation.refuse();
        setCodes({ kind: "asking", password: "", refused: true });
      } else {
        // It answered, but with a failure that says nothing about what it did
        // first. A 5xx resolves through the client rather than throwing, so
        // this is the same lost answer as the catch below and must not be read
        // as a refusal: the rotation may have committed before the failure,
        // leaving the old set void and the new one nowhere.
        rotation.lose();
        setCodes({ kind: "asking", password: "", refused: false });
      }
    } catch {
      // The call threw, so the answer is lost, and a lost answer is not a
      // refusal. The server may have committed the rotation before the
      // connection went, in which case the old set is already void and the
      // new one exists nowhere. Calling that "password not accepted" would let
      // the person leave believing nothing changed. So the vault stays at
      // stake, the page stays guarded, and the form says what is known: the
      // codes may have changed, and a set that does arrive is the way out.
      rotation.lose();
      setCodes({ kind: "asking", password: "", refused: false });
    }
  }

  const { viewer } = data;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className={fieldLabel}>{t("signIn")}</span>
        <dl className={kv}>
          <dt className={kvTerm}>{t("email")}</dt>
          <dd className={kvValue}>
            {viewer.email} ·{" "}
            {viewer.emailVerified ? t("verified") : t("unverified")}
          </dd>
          <dt className={kvTerm}>{t("twoFactor")}</dt>
          <dd className={kvValue}>
            {viewer.twoFactorEnabled ? t("twoFactorOn") : t("twoFactorOff")}
          </dd>
        </dl>
      </div>

      <div>
        <span className={fieldLabel}>{t("twoFactor")}</span>
        <div className={list} data-testid="account-two-factor">
          <div className={listRow}>
            <span
              className={`${listIcon} ${viewer.twoFactorEnabled ? "bg-success/15 text-success" : ""}`}
            >
              <Lock className="size-3" aria-hidden />
            </span>
            <div className={listBody}>
              <p className={listTitle}>{t("authenticator")}</p>
              <p className={listText}>
                {viewer.twoFactorEnabled
                  ? t("authenticatorOn")
                  : t("authenticatorOff")}
              </p>
              {/* Outside the password form on purpose. Cancel closes that
                  form, and a rotation nobody heard back from is not cancelled
                  by it. Inside the form, Cancel took the only line on screen
                  saying the codes may already be void away, and left an
                  ordinary Regenerate button in its place. */}
              {rotation.uncertain && !rotation.pending ? (
                <div className="mt-2">
                  <FormAlert testId="account-codes-uncertain">
                    {t("codesUncertain")}
                  </FormAlert>
                </div>
              ) : null}
              {codes.kind === "asking" ? (
                <form
                  className="mt-2 flex flex-wrap items-end gap-2"
                  noValidate
                  onSubmit={(e) => void regenerate(e)}
                >
                  <div className="min-w-0 flex-1">
                    <label htmlFor={passwordId} className={fieldLabel}>
                      {t("password")}
                    </label>
                    <input
                      id={passwordId}
                      type="password"
                      autoComplete="current-password"
                      data-testid="account-codes-password"
                      className={inputBase}
                      value={codes.password}
                      onChange={(e) => {
                        setCodes({ ...codes, password: e.target.value });
                      }}
                    />
                  </div>
                  <button
                    type="submit"
                    data-testid="account-codes-confirm"
                    aria-disabled={rotation.pending || undefined}
                    className={buttonSmall}
                  >
                    {rotation.pending ? t("issuing") : t("issue")}
                  </button>
                  <button
                    type="button"
                    data-testid="account-codes-cancel"
                    aria-disabled={rotation.pending || undefined}
                    className={buttonSmall}
                    onClick={() => {
                      // Cancel is honest or it is not offered. The rotation
                      // cannot be called back once it has left, and closing the
                      // form over one still running is what let a second start.
                      if (rotation.pending) return;
                      setCodes({ kind: "closed" });
                    }}
                  >
                    {t("cancel")}
                  </button>
                  {codes.refused ? (
                    <div className="basis-full">
                      <FormAlert testId="account-codes-refused">
                        {t("codesRefused")}
                      </FormAlert>
                    </div>
                  ) : null}
                </form>
              ) : null}
              {codes.kind === "issued" ? (
                <div className="mt-2" data-testid="account-codes">
                  <p className={listText}>{t("codesIssued")}</p>
                  <ol className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs">
                    {codes.codes.map((code) => (
                      <li key={code}>{code}</li>
                    ))}
                  </ol>
                  {/* Whether these were issued on this visit to the tab or
                      recovered from the vault, so the line is not a claim
                      about which. */}
                  <p
                    className={`${hint} mt-1.5`}
                    data-testid="account-codes-held"
                  >
                    {t("codesHeld")}
                  </p>
                  <button
                    type="button"
                    data-testid="account-codes-saved"
                    className={`${buttonSmall} mt-2`}
                    onClick={() => {
                      // The only signal that the single showing landed.
                      setHeldCodes(null);
                      setCodes({ kind: "closed" });
                    }}
                  >
                    {t("codesSaved")}
                  </button>
                </div>
              ) : null}
              {codes.kind === "blockedByOther" ? (
                <FormAlert testId="account-codes-blocked">
                  {t("codesBlockedByOther")}
                </FormAlert>
              ) : null}
              {codes.kind === "blockedElsewhere" ? (
                <FormAlert testId="account-codes-elsewhere">
                  {t("codesBlockedElsewhere")}
                </FormAlert>
              ) : null}
            </div>
            {viewer.twoFactorEnabled ? (
              codes.kind === "closed" ||
              codes.kind === "blockedByOther" ||
              codes.kind === "blockedElsewhere" ? (
                <button
                  type="button"
                  data-testid="account-codes-open"
                  className={buttonSmall}
                  onClick={() => {
                    setCodes({ kind: "asking", password: "", refused: false });
                  }}
                >
                  {t("regenerate")}
                </button>
              ) : null
            ) : (
              <SafeLink
                to={routes.mfaEnroll()}
                data-testid="account-two-factor-enroll"
                className={buttonSmall}
              >
                {t("setUp")}
              </SafeLink>
            )}
          </div>
        </div>
      </div>

      <div>
        <span className={fieldLabel}>{t("sessions")}</span>
        {sessions.kind === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("sessionsLoading")}
          </p>
        ) : sessions.kind === "failed" ? (
          <FormAlert testId="account-sessions-failed">
            {t("sessionsFailed")}
          </FormAlert>
        ) : (
          <div className={list} data-testid="account-sessions">
            {sessions.sessions.map((s) => (
              <div key={s.token} className={listRow}>
                <span className={listIcon}>
                  <KeyRound className="size-3" aria-hidden />
                </span>
                <div className={listBody}>
                  <p className={listTitle}>
                    {describeAgent(s.userAgent, t("unknownDevice"))}
                    {s.current ? (
                      <span className="rounded-md border border-success/45 bg-success/10 px-1.5 py-px text-[10.5px] font-semibold text-success">
                        {t("thisDevice")}
                      </span>
                    ) : null}
                  </p>
                  <p className={listText}>
                    {s.ipAddress ?? t("unknownAddress")}
                  </p>
                  {revokeFailed === s.token ? (
                    <FormAlert testId="account-session-revoke-failed">
                      {t("revokeFailed")}
                    </FormAlert>
                  ) : null}
                </div>
                <time className={listTime} dateTime={s.updatedAt.toISOString()}>
                  {s.current
                    ? t("now")
                    : format.dateTime(s.updatedAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                </time>
                {s.current ? null : (
                  <button
                    type="button"
                    data-testid="account-session-revoke"
                    aria-disabled={revoking !== null || undefined}
                    className={buttonSmall}
                    onClick={() => void revoke(s.token)}
                  >
                    {revoking === s.token ? t("revoking") : t("revoke")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <p role="status" className="sr-only">
          {revoked ? t("revoked") : ""}
        </p>
        <p className={hint}>{t("sessionsHint")}</p>
      </div>
    </div>
  );
}

/* ============================== Privacy ============================== */

/**
 * How often the queued state asks after the bundle. `export_data` answers the
 * moment it queues and the bundle is written later by an Inngest function, so
 * without this the id is all a person would ever see. Three seconds is a
 * compromise: a small export is ready inside one interval, and a large one
 * costs a handful of reads of a single row. The interval is cleared when the
 * export settles and when the dialog closes, so a shut dialog polls nothing.
 */
const EXPORT_POLL_MS = 3_000;

function PrivacyTab({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account.privacy");
  const { state, setState, begin } = useAccountExport(
    data.viewer.id,
    data.org.slug,
  );

  async function ask(scope: "user" | "org") {
    if (!begin(scope)) return;
    try {
      const result = await requestExport(data.org.slug, scope);
      if (result.ok)
        setState({ kind: "queued", scope, exportId: result.value.exportId });
      else if (result.reason === "denied") setState({ kind: "denied", scope });
      else setState({ kind: "failed", scope });
    } catch {
      setState({ kind: "failed", scope });
    }
  }

  // Ask after a queued bundle until it settles. A read that fails transiently
  // or throws leaves the state alone and the next tick tries again: a blip on
  // one poll is not a failed export, and the person keeps the id either way.
  // A refusal is different, and it is not hypothetical: `get_export_status`
  // re-checks Owner or Admin on an organization export at read time, so an
  // Owner demoted while the bundle is being written starts being refused
  // mid-poll. Retrying that every three seconds until the tab closes asks a
  // question already answered, under a line still promising an update.
  const queuedId = state.kind === "queued" ? state.exportId : null;
  const queuedScope = state.kind === "queued" ? state.scope : null;
  const orgSlug = data.org.slug;
  useEffect(() => {
    if (queuedId === null || queuedScope === null) return;
    // Bound after the guard so `look` closes over the narrowed values. It
    // cannot narrow them itself: they are nullable state read from an outer
    // scope, and the check that rules out null is out here, not in there.
    const exportId = queuedId;
    const scope = queuedScope;
    let live = true;
    // One request at a time. A server action slower than the interval would
    // otherwise have a second tick start another before the first answered,
    // and a degraded server is exactly when that happens: the tab would pile
    // up concurrent reads of one row for as long as it stayed open, adding
    // load to the outage it is waiting out.
    let asking = false;
    async function look() {
      if (asking) return;
      asking = true;
      // The catch is the point, not a formality: a server action whose request
      // loses its connection rejects, and an uncaught rejection here would
      // repeat every tick until the tab closes. A throw is the same as a
      // refusal: leave the state alone and try again on the next tick.
      try {
        const read = await readExportStatus(orgSlug, exportId);
        if (!live) return;
        if (!read.ok) {
          // Terminal, and only this one: `denied` is a decision, not a blip.
          if (read.reason === "denied") setState({ kind: "denied", scope });
          return;
        }
        if (read.value.ready) setState({ kind: "ready", scope, exportId });
        else if (read.value.status === "failed")
          setState({ kind: "expired", scope, exportId });
      } catch {
        return;
      } finally {
        // Released on every exit, including the early returns above and a
        // thrown request: a flag left set would stop the poller for good.
        asking = false;
      }
    }
    const timer = setInterval(() => {
      void look();
    }, EXPORT_POLL_MS);
    void look();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [queuedId, queuedScope, orgSlug, setState]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <span className={fieldLabel}>{t("export")}</span>
        <p className={`${hint} mt-0`}>
          {t.rich("exportHint", {
            code: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="account-export-user"
            aria-disabled={
              state.kind === "pending" || state.kind === "queued" || undefined
            }
            className={buttonPrimary}
            onClick={() => void ask("user")}
          >
            {state.kind === "pending" && state.scope === "user"
              ? t("exporting")
              : t("exportMine")}
          </button>
          <button
            type="button"
            data-testid="account-export-org"
            aria-disabled={
              state.kind === "pending" || state.kind === "queued" || undefined
            }
            className={buttonSmall}
            onClick={() => void ask("org")}
          >
            {state.kind === "pending" && state.scope === "org"
              ? t("exporting")
              : t("exportOrg")}
          </button>
        </div>
        <p role="status" data-testid="account-export-status" className={hint}>
          {state.kind === "queued" ? (
            <span data-testid="account-export-queued">
              {t.rich("queued", {
                id: state.exportId,
                code: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </span>
          ) : null}
          {state.kind === "ready" ? (
            <span data-testid="account-export-ready">
              {t("ready")}{" "}
              <DownloadLink
                data-testid="account-export-download"
                className="underline"
                to={routes.accountExport(data.org.slug, state.exportId)}
              >
                {t("download")}
              </DownloadLink>
            </span>
          ) : null}
        </p>
        {state.kind === "expired" ? (
          <FormAlert testId="account-export-expired">{t("expired")}</FormAlert>
        ) : null}
        {state.kind === "denied" || state.kind === "failed" ? (
          <FormAlert testId={`account-export-${state.kind}`}>
            {t(
              state.kind === "denied" && state.scope === "org"
                ? "deniedOrg"
                : state.kind,
            )}
          </FormAlert>
        ) : null}
      </div>

      <div>
        <span className={fieldLabel}>{t("erasure")}</span>
        <p className={`${hint} mt-0`}>
          {t.rich("erasureHint", {
            code: (chunks) => <span className="font-mono">{chunks}</span>,
          })}
        </p>
      </div>
    </div>
  );
}
