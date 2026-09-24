"use client";
// Step 2 of Register an agent (register-wrap spec): wrap it. The harness tabs
// open on the one the name step recorded; each panel says what wrapping does,
// shows the tier ladder, and holds what the operator runs on the host.
//
// What is backed and what is not, element by element:
// - The one-time enrollment token is `create_enrollment_token`, minted when the
//   operator asks and shown once with the command that presents it.
// - The agent credential on the SDK tab is `rotate_agent_credential`, shown
//   once when issued; before that, the live credential's prefix.
// - Signed installers with the token embedded are not published, so Download
//   is drawn disabled and says what it would do, and the package line is not
//   drawn. The SDK package and its five-line wrap are not published either.
// - The tier ladder is the closed tier vocabulary (spec §8.4): `harness` is
//   what a hooked host earns, `gateway` and `contained` the rungs above it.
//
// Continuing moves the gate's step when this workspace is the gate's, so the
// record follows the operator rather than a timer.
import { useTranslations } from "next-intl";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  mono,
  panel,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { advanceOnboarding, issueEnrollmentToken } from "../actions";
import {
  type Harness,
  WRAP_TABS,
  type WrapTab,
  wrapTabFor,
} from "../agent-form";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { issueAgentCredential } from "../register-actions";
import { CancelRegistration } from "./cancel-registration";

const OPERATING_SYSTEMS = ["macos", "windows", "linux"] as const;
type Os = (typeof OPERATING_SYSTEMS)[number];

const LANGUAGE_TABS = "flex rounded-[9px] border border-border bg-hl p-[3px]";
const osTab =
  "flex-1 rounded-md px-3 py-1.5 text-[13px] text-muted-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-sm focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11";
const tokenBox =
  "rounded-lg border border-dashed border-border bg-hl px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground";
const codeLine = `${mono} block overflow-x-auto whitespace-pre rounded-lg border border-border bg-hl px-3 py-2.5 text-[12px]`;

type Token = { token: string; expiresAt: string; enrollCommand: string };
type Credential = { secret: string };

/** Arrow keys move along a tab list and select as they move (WAI-ARIA tabs, automatic activation). */
function tabKeyHandler<T extends string>(
  items: readonly T[],
  current: T,
  select: (next: T) => void,
  id: (item: T) => string,
) {
  return (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = items.indexOf(current);
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = items[(at + step + items.length) % items.length];
    if (next === undefined) return;
    select(next);
    document.getElementById(id(next))?.focus();
  };
}

function Ladder({ observe }: { observe: boolean }) {
  const t = useTranslations("onboarding.register.wrap.ladder");
  const rows: [string, "harness" | "gateway" | "contained"][] = [
    [t("thisAgent"), "harness"],
    [t("nextRung"), "gateway"],
    [t("topRung"), "contained"],
  ];
  return (
    <ul
      data-testid="tier-ladder"
      className="divide-y divide-border rounded-lg border border-border"
    >
      {rows.map(([label, tier]) => (
        <li
          key={tier}
          className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]"
        >
          <span>{label}</span>
          <span className="flex items-center gap-1.5">
            <Badge tone="quiet" dot={false} mono data-tier={tier}>
              {tier}
            </Badge>
            {observe && tier === "harness" ? (
              <Badge tone="quiet" dot={false}>
                {t("orObserve")}
              </Badge>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TokenBox({
  org,
  ws,
  agentId,
  token,
  onToken,
}: {
  org: string;
  ws: string;
  agentId: string;
  token: Token | null;
  onToken: (token: Token) => void;
}) {
  const t = useTranslations("onboarding.register.wrap.token");
  const failureText = useOnboardingFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function issue() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await issueEnrollmentToken(org, ws, agentId);
      if (result.ok) onToken(result.value);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div data-testid="enrollment-token" className={tokenBox}>
        {t("label")}
        {token === null ? null : (
          <>
            <br />
            <b
              data-testid="enrollment-token-value"
              className="break-all text-accent-text"
            >
              {token.token}
            </b>
            <br />
            <span className="text-muted-foreground">
              <Expiry at={token.expiresAt} />
            </span>
          </>
        )}
      </div>
      {failure === null ? null : (
        <FormAlert testId="wrap-failure">{failure}</FormAlert>
      )}
      {token === null ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => void issue()}
          className={`${buttonSecondary} self-start max-md:w-full`}
        >
          {pending ? t("issuing") : t("issue")}
        </button>
      ) : (
        <>
          <span className="text-xs text-muted-foreground">{t("orRun")}</span>
          <code data-testid="enroll-command" className={codeLine}>
            {token.enrollCommand}
          </code>
        </>
      )}
    </>
  );
}

/** When the token stops being accepted, as the operator's clock time. */
function Expiry({ at }: { at: string }) {
  const t = useTranslations("onboarding.register.wrap.token");
  const format = useFormatter();
  return (
    <>
      {t("expires", {
        at: format.dateTime(new Date(at), { timeStyle: "short" }),
      })}
    </>
  );
}

function Download({
  org,
  ws,
  agentId,
  token,
  onToken,
}: {
  org: string;
  ws: string;
  agentId: string;
  token: Token | null;
  onToken: (token: Token) => void;
}) {
  const t = useTranslations("onboarding.register.wrap.download");
  const baseId = useId();
  const [os, setOs] = useState<Os>("macos");
  const tabId = (item: Os) => `${baseId}-os-${item}`;
  const onKey = tabKeyHandler(OPERATING_SYSTEMS, os, setOs, tabId);
  return (
    <div className={`${panel} flex flex-col gap-3 p-3.5`}>
      <p className={eyebrow}>{t("eyebrow")}</p>
      <div role="tablist" aria-label={t("osLabel")} className={LANGUAGE_TABS}>
        {OPERATING_SYSTEMS.map((item) => (
          <button
            key={item}
            id={tabId(item)}
            type="button"
            role="tab"
            aria-selected={os === item}
            tabIndex={os === item ? 0 : -1}
            onClick={() => {
              setOs(item);
            }}
            onKeyDown={onKey}
            className={osTab}
          >
            {t(`os.${item}`)}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled
        data-testid="download-installer"
        aria-describedby={`${baseId}-unpublished`}
        className={`${buttonPrimary} w-full`}
      >
        {t("button", { os: t(`os.${os}`) })}
      </button>
      {/* Not backed until #3897 lands. */}
      <p
        id={`${baseId}-unpublished`}
        data-testid="not-backed"
        data-element="signed-installer"
        className="text-xs text-muted-foreground"
      >
        {t("notPublished")}
      </p>
      <TokenBox
        org={org}
        ws={ws}
        agentId={agentId}
        token={token}
        onToken={onToken}
      />
    </div>
  );
}

function CredentialColumn({
  org,
  ws,
  agentId,
  prefix,
}: {
  org: string;
  ws: string;
  agentId: string;
  /** The live credential's prefix; null when the agent holds none. */
  prefix: string | null;
}) {
  const t = useTranslations("onboarding.register.wrap.credential");
  const failureText = useOnboardingFailure();
  const [credential, setCredential] = useState<Credential | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function issue() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await issueAgentCredential(org, ws, agentId);
      if (result.ok) setCredential({ secret: result.value.secret });
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={`${panel} flex flex-col gap-3 p-3.5`}>
      <p className={eyebrow}>{t("eyebrow")}</p>
      <div data-testid="agent-credential" className={tokenBox}>
        {t("label")}
        <br />
        <b className="break-all text-accent-text">
          {credential !== null
            ? credential.secret
            : prefix !== null
              ? `${prefix}••••••••••••`
              : t("none")}
        </b>
        <br />
        <span className="text-muted-foreground">{t("facts")}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t.rich("use", {
          code: (chunks) => <span className={mono}>{chunks}</span>,
        })}
      </p>
      {failure === null ? null : (
        <FormAlert testId="credential-failure">{failure}</FormAlert>
      )}
      {credential === null ? (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => void issue()}
            className={`${buttonSecondary} self-start max-md:w-full`}
          >
            {pending ? t("issuing") : t("issue")}
          </button>
          <p className="text-xs text-muted-foreground">{t("issueNote")}</p>
        </>
      ) : null}
    </div>
  );
}

function Panel({
  tab,
  tabId,
  panelId,
  children,
}: {
  tab: WrapTab;
  tabId: string;
  panelId: string;
  children: ReactNode;
}) {
  const t = useTranslations("onboarding.register.wrap");
  const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;
  return (
    <section
      id={panelId}
      role="tabpanel"
      aria-labelledby={tabId}
      data-tab={tab}
      className="grid gap-5 p-[18px] md:grid-cols-2"
    >
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          {t(`tabs.${tab}.name`)}
          {tab === "claude-code" ? (
            <Badge tone="allowed" dot={false}>
              {t("recommended")}
            </Badge>
          ) : null}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {t.rich(`body.${tab}`, { code })}
        </p>
        <Ladder observe={tab === "codex"} />
        {tab === "sdk" ? null : (
          <p className="text-[13px] text-muted-foreground">
            {tab === "codex" ? t("codexNote") : t("tierNote")}
          </p>
        )}
        {tab === "cursor" ? (
          <p className="text-[13px] text-muted-foreground">{t("cursorNote")}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function WrapAgent({
  org,
  ws,
  agentId,
  harness,
  credentialPrefix,
  gated,
  back,
  next,
  fleet,
}: {
  org: string;
  ws: string;
  agentId: string;
  harness: Harness;
  credentialPrefix: string | null;
  /** True when this workspace carries the organization's open gate. */
  gated: boolean;
  back: SafePath;
  next: SafePath;
  fleet: SafePath;
}) {
  const t = useTranslations("onboarding.register.wrap");
  const registerT = useTranslations("onboarding.register");
  const credentialT = useTranslations("onboarding.register.wrap.credential");
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const baseId = useId();
  const [tab, setTab] = useState<WrapTab>(() => wrapTabFor(harness));
  const [token, setToken] = useState<Token | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const tabId = (item: WrapTab) => `${baseId}-tab-${item}`;
  const panelId = `${baseId}-panel`;
  const onKey = tabKeyHandler(WRAP_TABS, tab, setTab, tabId);

  async function advance() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      if (gated) {
        const result = await advanceOnboarding(org, ws, "run");
        if (!result.ok) {
          setFailure(failureText(result));
          return;
        }
      }
      navigate.push(next);
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={`${panel} flex flex-col`}>
        <div
          role="tablist"
          aria-label={t("tabsLabel")}
          className="grid grid-cols-2 border-b border-border md:grid-cols-4"
        >
          {WRAP_TABS.map((item) => (
            <button
              key={item}
              id={tabId(item)}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={panelId}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => {
                setTab(item);
              }}
              onKeyDown={onKey}
              className="flex min-h-11 flex-col items-start gap-0.5 border-b-2 border-transparent px-3.5 py-3 text-left aria-selected:border-accent-text aria-selected:bg-hl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <span className="text-[13.5px] font-semibold">
                {t(`tabs.${item}.name`)}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground max-md:hidden">
                {t(`tabs.${item}.sub`)}
              </span>
            </button>
          ))}
        </div>
        <Panel tab={tab} tabId={tabId(tab)} panelId={panelId}>
          {tab === "sdk" ? (
            <div className="flex min-w-0 flex-col gap-3">
              <CredentialColumn
                org={org}
                ws={ws}
                agentId={agentId}
                prefix={credentialPrefix}
              />
              {/* Not backed until #3898 lands. */}
              <p
                data-testid="not-backed"
                data-element="sdk-package"
                className="text-xs text-muted-foreground"
              >
                {credentialT("sdkNotPublished")}
              </p>
            </div>
          ) : (
            <Download
              org={org}
              ws={ws}
              agentId={agentId}
              token={token}
              onToken={setToken}
            />
          )}
        </Panel>
      </div>
      {failure === null ? null : (
        <FormAlert testId="advance-failure">{failure}</FormAlert>
      )}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <CancelRegistration
          org={org}
          ws={ws}
          agentId={agentId}
          fleet={fleet}
          testId="register-cancel"
          className="max-md:w-full"
        />
        <SafeLink to={back} className={`${buttonSecondary} max-md:w-full`}>
          {registerT("back")}
        </SafeLink>
        <span className="text-xs text-muted-foreground md:ml-auto">
          {t("caption")}
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => void advance()}
          className={`${buttonSecondary} max-md:w-full`}
        >
          {pending ? t("advancing") : t("continue")}
        </button>
      </div>
    </div>
  );
}
