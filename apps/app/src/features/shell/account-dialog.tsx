"use client";
// The Account dialog (spec App. F: the account pages collapse into one dialog
// reachable from the user menu). Tabs: profile, preferences, security, privacy.
// Reads only; the writes (set_preferences, session revoke, export, erasure)
// land with Batch 4, so no control here pretends to save.
import { Dialog } from "@base-ui/react/dialog";
import { Tabs } from "@base-ui/react/tabs";
import { Fingerprint, KeyRound, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, type ReactNode } from "react";
import type { AccountView } from "@/data/contracts/shell";
import { formatTimestamp, initials } from "./format";
import type { ShellData } from "./shell-data";
import { ACCOUNT_TABS, type AccountTab, useShellState } from "./shell-state";
import { parseTheme, THEMES } from "./theme";

const fieldLabel =
  "mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground";
const hint = "mt-1.5 text-xs text-muted-foreground";
const control =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-70";

function KeyValues({
  rows,
}: {
  rows: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/50 px-3 py-2.5 font-mono text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={fieldLabel}>{title}</h3>
      {children}
    </section>
  );
}

function Profile({ account }: { account: AccountView }) {
  const t = useTranslations("shell.account.profile");
  const locale = useLocale();
  const nameId = useId();
  const emailId = useId();
  const { profile } = account;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className="grid size-13 flex-none place-items-center rounded-full bg-secondary text-base font-semibold text-secondary-foreground"
        >
          {initials(profile.name)}
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold">{profile.name}</p>
          <p className="truncate text-sm text-muted-foreground">
            {profile.emailVerifiedAt === null
              ? t("unverified", { email: profile.email })
              : t("verified", {
                  email: profile.email,
                  date: formatTimestamp(profile.emailVerifiedAt, locale),
                })}
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={nameId} className={fieldLabel}>
            {t("displayName")}
          </label>
          <input
            id={nameId}
            className={control}
            value={profile.name}
            readOnly
          />
        </div>
        <div>
          <label htmlFor={emailId} className={fieldLabel}>
            {t("email")}
          </label>
          <input
            id={emailId}
            type="email"
            className={control}
            value={profile.email}
            readOnly
            disabled
          />
          {profile.managedBy === null ? null : (
            <p className={hint}>
              {t("managedBy", { provider: profile.managedBy })}
            </p>
          )}
        </div>
      </div>
      <Section title={t("roles")}>
        <KeyValues
          rows={[
            ...profile.roles.map((r) => [r.scope, r.role] as const),
            [
              t("principal"),
              t("principalValue", { id: profile.principalId }),
            ] as const,
          ]}
        />
        <p className={hint}>{t("rolesHint")}</p>
      </Section>
    </div>
  );
}

function Preferences({ account }: { account: AccountView | null }) {
  const t = useTranslations("shell.account.preferences");
  const { theme, setTheme } = useShellState();
  const localeId = useId();
  const currencyId = useId();
  const tzId = useId();
  const themeId = useId();
  const prefs = account?.preferences ?? null;
  return (
    <div className="flex flex-col gap-5">
      {prefs === null ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={localeId} className={fieldLabel}>
                {t("locale")}
              </label>
              <select
                id={localeId}
                className={control}
                value={prefs.locale}
                disabled
              >
                <option value="en-US">{t("locales.en-US")}</option>
                <option value="de" disabled>
                  {t("locales.de")}
                </option>
                <option value="ja" disabled>
                  {t("locales.ja")}
                </option>
              </select>
              <p className={hint}>{t("localeHint")}</p>
            </div>
            <div>
              <label htmlFor={currencyId} className={fieldLabel}>
                {t("currency")}
              </label>
              <select
                id={currencyId}
                className={control}
                value={prefs.displayCurrency}
                disabled
              >
                <option value="USD">{t("currencies.USD")}</option>
                <option value="EUR" disabled>
                  {t("currencies.EUR")}
                </option>
              </select>
              <p className={hint}>{t("currencyHint")}</p>
            </div>
          </div>
          <div>
            <label htmlFor={tzId} className={fieldLabel}>
              {t("timeZone")}
            </label>
            <input
              id={tzId}
              className={control}
              value={prefs.timeZone}
              readOnly
              disabled
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor={themeId} className={fieldLabel}>
          {t("theme")}
        </label>
        <select
          id={themeId}
          data-testid="theme-select"
          className={control}
          value={theme}
          onChange={(e) => {
            setTheme(parseTheme(e.target.value));
          }}
        >
          {THEMES.map((value) => (
            <option key={value} value={value}>
              {t(`themes.${value}`)}
            </option>
          ))}
        </select>
        <p className={hint}>{t("themeHint")}</p>
      </div>
    </div>
  );
}

function Security({ account }: { account: AccountView }) {
  const t = useTranslations("shell.account.security");
  const locale = useLocale();
  const { security } = account;
  return (
    <div className="flex flex-col gap-5">
      <Section title={t("signIn")}>
        <KeyValues
          rows={[
            [
              t("provider"),
              security.signInProvider === null
                ? t("providerLocal")
                : t("providerValue", {
                    provider: security.signInProvider,
                    password: String(security.passwordSignIn),
                  }),
            ],
          ]}
        />
      </Section>
      <Section title={t("twoFactor")}>
        <ul className="divide-y divide-border rounded-md border border-border">
          {security.factors.map((f) => {
            const Icon = f.kind === "totp" ? KeyRound : Fingerprint;
            return (
              <li key={f.kind} className="flex gap-3 px-3 py-2.5">
                <Icon
                  aria-hidden="true"
                  className={`mt-0.5 size-4 flex-none ${f.enrolledAt === null ? "text-muted-foreground" : "text-success"}`}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t(`factor.${f.kind}`)}</p>
                  <p className="text-xs text-muted-foreground">
                    {f.enrolledAt === null
                      ? t("notEnrolled")
                      : f.kind === "totp" && f.recoveryCodesRemaining !== null
                        ? t("totpEnrolled", {
                            date: formatTimestamp(f.enrolledAt, locale),
                            remaining: f.recoveryCodesRemaining,
                          })
                        : t("passkeyEnrolled", {
                            date: formatTimestamp(f.enrolledAt, locale),
                          })}
                    {f.kind === "passkey" ? ` ${t("passkeyHint")}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>
      <Section title={t("sessions")}>
        <ul className="divide-y divide-border rounded-md border border-border">
          {security.sessions.map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {s.device}
                  {s.current ? (
                    <span className="rounded border border-current px-1.5 text-[11px] text-success">
                      {t("thisDevice")}
                    </span>
                  ) : null}
                </p>
                {s.location === null ? null : (
                  <p className="text-xs text-muted-foreground">{s.location}</p>
                )}
              </div>
              <time
                dateTime={s.lastActiveAt}
                className="font-mono text-[11px] text-muted-foreground"
              >
                {formatTimestamp(s.lastActiveAt, locale)}
              </time>
            </li>
          ))}
        </ul>
        <p className={hint}>{t("sessionsHint")}</p>
      </Section>
    </div>
  );
}

function Privacy({ account, data }: { account: AccountView; data: ShellData }) {
  const t = useTranslations("shell.account.privacy");
  const org = data.context.ok ? data.context.value.org : null;
  const { privacy } = account;
  return (
    <div className="flex flex-col gap-5">
      <Section title={t("export")}>
        <p className="text-sm text-muted-foreground">{t("exportHint")}</p>
      </Section>
      <Section title={t("erasure")}>
        <p className="text-sm text-muted-foreground">{t("erasureHint")}</p>
      </Section>
      <Section title={t("kept")}>
        <KeyValues
          rows={[
            [
              t("frameBodies"),
              privacy.retentionYears === null
                ? t("notRecorded")
                : t("frameBodiesValue", { years: privacy.retentionYears }),
            ],
            [t("runLedger"), t("runLedgerValue")],
            ...(org === null
              ? []
              : [
                  [
                    t("dataPlane"),
                    t("dataPlaneValue", {
                      plane: org.dataPlane,
                      region: org.region ?? "none",
                    }),
                  ] as const,
                ]),
            [
              t("legalHolds"),
              privacy.legalHolds === null
                ? t("notRecorded")
                : t("legalHoldsValue", { count: privacy.legalHolds }),
            ],
          ]}
        />
        <p className={hint}>{t("requestsHint")}</p>
      </Section>
    </div>
  );
}

export function AccountDialog({ data }: { data: ShellData }) {
  const t = useTranslations("shell.account");
  const { accountTab, setAccountTab } = useShellState();
  const read = data.account;
  const account = read.ok ? read.value : null;
  const unavailable = read.ok ? null : (
    <div
      data-testid="account-unavailable"
      className="rounded-md border border-border px-3 py-3"
    >
      <p className="text-sm font-medium">{t("unavailable.title")}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("unavailable.body", {
          code: read.reason === "error" ? read.code : read.reason,
          status:
            read.reason === "error"
              ? read.status
              : read.reason === "denied"
                ? 403
                : 501,
        })}
      </p>
    </div>
  );
  const panel = (tab: AccountTab): ReactNode => {
    if (tab === "preferences") return <Preferences account={account} />;
    if (account === null) return unavailable;
    if (tab === "profile") return <Profile account={account} />;
    if (tab === "security") return <Security account={account} />;
    return <Privacy account={account} data={data} />;
  };
  return (
    <Dialog.Root
      open={accountTab !== null}
      onOpenChange={(open) => {
        if (!open) setAccountTab(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay-scrim" />
        <Dialog.Popup
          data-testid="account-dialog"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-dialog-border bg-dialog-bg text-dialog-fg shadow-2xl"
        >
          <Tabs.Root
            value={accountTab ?? "profile"}
            onValueChange={(value: AccountTab) => {
              setAccountTab(value);
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex flex-none items-center gap-2 px-5 pt-4">
              <Dialog.Title className="text-lg font-semibold">
                {t("title")}
              </Dialog.Title>
              <Dialog.Close
                aria-label={t("close")}
                className="ml-auto rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <X aria-hidden="true" className="size-4" />
              </Dialog.Close>
            </div>
            <Tabs.List className="flex flex-none gap-1 overflow-x-auto border-b border-border px-4 pt-2">
              {ACCOUNT_TABS.map((tab) => (
                <Tabs.Tab
                  key={tab}
                  value={tab}
                  className="-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[active]:border-primary data-[active]:text-foreground"
                >
                  {t(`tabs.${tab}`)}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            {ACCOUNT_TABS.map((tab) => (
              <Tabs.Panel
                key={tab}
                value={tab}
                data-testid={`account-panel-${tab}`}
                className="min-h-0 flex-1 overflow-y-auto px-5 py-5 outline-none"
              >
                {panel(tab)}
              </Tabs.Panel>
            ))}
          </Tabs.Root>
          <p className="flex-none border-t border-border px-5 py-3 text-xs text-muted-foreground">
            {t("footer")}
          </p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
