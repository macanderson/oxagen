"use client";
// The Account dialog (spec App. F; mockup `accountBody`/`accountTabs`): the
// account pages collapse into one dialog reachable from the user menu, with
// four tabs — Profile, Preferences, Security, Privacy. The mockup's fifth tab
// is an onboarding demo and is not a product tab.
//
// Every control here saves or acts, and none is a stub: Profile writes
// `update_profile`; Preferences reads `get_user_preferences` and writes
// `set_preferences`; Security lists and revokes Better Auth sessions and
// reissues recovery codes; Privacy queues `export_data`. What the product
// cannot do yet is absent, not drawn — a control that cannot act is the thing
// this file exists to stop shipping.
//
// It is a `SheetDialog` like every other dialog in the app, so on a phone it
// rises from the bottom edge with a drag handle, a scrim, safe-area padding
// and a full-width footer button (ARCHITECTURE.md §1.2, the phone shell;
// src/ui/phone.css).
import { KeyRound, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useId, useState } from "react";
import { routes } from "@/shared/safe-path";
import { Avatar } from "@/ui/avatar";
import { buttonPrimary, inputBase, panel } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { formatCount, formatMoney } from "@/ui/money-format";
import { SafeLink, useNavigate } from "@/ui/navigation";
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
import {
  liveListSessions,
  liveRegenerateBackupCodes,
  liveRevokeSession,
  type LiveSession,
} from "./session-client";
import type { ShellData } from "./shell-data";
import { ACCOUNT_TABS, type AccountTab, useShellState } from "./shell-state";
import type { Theme } from "./theme";

type Outcome = "saved" | "invalid" | "denied" | "failed";

const tabClass =
  "inline-flex min-h-10 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-selected:border-brand aria-selected:text-foreground";

export function AccountDialog({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account");
  const { accountOpen, setAccountOpen, accountTab, setAccountTab } =
    useShellState();
  return (
    <SheetDialog
      open={accountOpen}
      onOpenChange={setAccountOpen}
      title={t("title")}
      testId="account-dialog"
      wide
      tabs={
        <div
          role="tablist"
          aria-label={t("title")}
          className="-mb-px flex gap-0.5 overflow-x-auto border-b border-border"
        >
          {ACCOUNT_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`account-tab-${tab}`}
              data-testid={`account-tab-${tab}`}
              aria-selected={accountTab === tab}
              aria-controls={`account-panel-${tab}`}
              className={tabClass}
              onClick={() => {
                setAccountTab(tab);
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
          <AccountPanel key={accountTab} tab={accountTab} data={data} />
        </div>
      ) : null}
    </SheetDialog>
  );
}

function AccountPanel({ tab, data }: { tab: AccountTab; data: ShellData }) {
  if (tab === "preferences") return <PreferencesTab data={data} />;
  if (tab === "security") return <SecurityTab data={data} />;
  if (tab === "privacy") return <PrivacyTab data={data} />;
  return <ProfileTab data={data} />;
}

/* ============================== Profile ============================== */

function ProfileTab({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account");
  const navigate = useNavigate();
  const { setAvatarOpen } = useShellState();
  const { viewer, org } = data;
  const nameId = useId();
  const emailId = useId();
  const [displayName, setDisplayName] = useState(viewer.name ?? "");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * "Saved." describes the draft that was submitted, so the first edit after a
   * save makes it false: the field in front of the person now holds a change
   * that is not persisted, under a line claiming it is. A refusal is left
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
      const result = await updateProfile(org.slug, {
        displayName,
        avatarUrl: viewer.avatarUrl ?? "",
      });
      if (result.ok) {
        setDisplayName(result.value.displayName ?? displayName);
        setOutcome("saved");
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
      setPending(false);
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
          <dt className={kvTerm}>{t("principal")}</dt>
          <dd className={kvValue}>
            {viewer.id} · {t("principalKind")}
          </dd>
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

/** The zones the browser knows, with the stored one kept even when it is not among them. */
function timeZones(current: string): string[] {
  let zones: string[] = ["UTC"];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // An older engine lists nothing; the stored zone still appears below.
  }
  return zones.includes(current) ? zones : [current, ...zones];
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
  const { theme, setTheme } = useShellState();
  const localeId = useId();
  const zoneId = useId();
  const themeId = useId();
  const [state, setState] = useState<PrefsState>({ kind: "loading" });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void readPreferences(data.org.slug)
      .then((result) => {
        if (!live) return;
        if (result.ok) setState({ kind: "ready", draft: result.value });
        else if (result.reason === "denied") setState({ kind: "denied" });
        else setState({ kind: "failed" });
      })
      .catch(() => {
        if (live) setState({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [data.org.slug]);

  function edit(patch: Partial<PreferencesDraft>) {
    if (outcome === "saved") setOutcome(null);
    setState((s) =>
      s.kind === "ready"
        ? { kind: "ready", draft: { ...s.draft, ...patch } }
        : s,
    );
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || state.kind !== "ready") return;
    setOutcome(null);
    setPending(true);
    try {
      const result = await savePreferences(data.org.slug, state.draft);
      if (result.ok) {
        setState({ kind: "ready", draft: result.value });
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
              edit({ theme: next });
              // The page follows the choice at once; Save records it.
              if (next !== theme) setTheme(next);
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

type CodesState =
  | { kind: "closed" }
  | { kind: "asking"; password: string; pending: boolean; refused: boolean }
  | { kind: "issued"; codes: string[] };

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

function SecurityTab({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account.security");
  const passwordId = useId();
  const [sessions, setSessions] = useState<SessionsState>({ kind: "loading" });
  const [codes, setCodes] = useState<CodesState>({ kind: "closed" });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);

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
      } else setSessions({ kind: "failed" });
    } catch {
      setSessions({ kind: "failed" });
    } finally {
      setRevoking(null);
    }
  }

  async function regenerate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (codes.kind !== "asking" || codes.pending) return;
    setCodes({ ...codes, pending: true, refused: false });
    try {
      const result = await liveRegenerateBackupCodes(codes.password);
      if (result.ok) setCodes({ kind: "issued", codes: result.codes });
      else
        setCodes({
          kind: "asking",
          password: "",
          pending: false,
          refused: true,
        });
    } catch {
      setCodes({ kind: "asking", password: "", pending: false, refused: true });
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
                    aria-disabled={codes.pending || undefined}
                    className={buttonSmall}
                  >
                    {codes.pending ? t("issuing") : t("issue")}
                  </button>
                  <button
                    type="button"
                    className={buttonSmall}
                    onClick={() => {
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
                </div>
              ) : null}
            </div>
            {viewer.twoFactorEnabled ? (
              codes.kind === "closed" ? (
                <button
                  type="button"
                  data-testid="account-codes-open"
                  className={buttonSmall}
                  onClick={() => {
                    setCodes({
                      kind: "asking",
                      password: "",
                      pending: false,
                      refused: false,
                    });
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
                </div>
                <time className={listTime} dateTime={s.updatedAt.toISOString()}>
                  {s.current
                    ? t("now")
                    : s.updatedAt.toISOString().slice(0, 16).replace("T", " ") +
                      "Z"}
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

type ExportState =
  | { kind: "idle" }
  | { kind: "pending"; scope: "user" | "org" }
  | { kind: "queued"; scope: "user" | "org"; exportId: string }
  | { kind: "ready"; scope: "user" | "org"; exportId: string }
  | { kind: "expired"; scope: "user" | "org"; exportId: string }
  | { kind: "denied"; scope: "user" | "org" }
  | { kind: "failed"; scope: "user" | "org" };

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
  const [state, setState] = useState<ExportState>({ kind: "idle" });

  async function ask(scope: "user" | "org") {
    if (state.kind === "pending") return;
    setState({ kind: "pending", scope });
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

  // Ask after a queued bundle until it settles. A read that refuses or throws
  // leaves the state alone and the next tick tries again: a blip on one poll
  // is not a failed export, and the person keeps the id either way.
  const queuedId = state.kind === "queued" ? state.exportId : null;
  const queuedScope = state.kind === "queued" ? state.scope : null;
  const orgSlug = data.org.slug;
  useEffect(() => {
    if (queuedId === null || queuedScope === null) return;
    let live = true;
    async function look() {
      const read = await readExportStatus(orgSlug, queuedId as string);
      if (!live || !read.ok) return;
      const scope = queuedScope as "user" | "org";
      const id = queuedId as string;
      if (read.value.ready) setState({ kind: "ready", scope, exportId: id });
      else if (read.value.status === "failed")
        setState({ kind: "expired", scope, exportId: id });
    }
    const timer = setInterval(() => {
      void look();
    }, EXPORT_POLL_MS);
    void look();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [queuedId, queuedScope, orgSlug]);

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
            aria-disabled={state.kind === "pending" || undefined}
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
            aria-disabled={state.kind === "pending" || undefined}
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
              <SafeLink
                data-testid="account-export-download"
                className="underline"
                to={routes.accountExport(data.org.slug, state.exportId)}
              >
                {t("download")}
              </SafeLink>
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
