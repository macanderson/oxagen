"use client";
// Onboarding step 2, Wrap an agent (mockup `regWrap` in onboard mode): three
// harness tabs, each a panel with its copy, the tier ladder and a right column,
// then the footer. The gold action is Download for <OS> on the Claude Code and
// Codex CLI panels; the SDK panel has none, and the continue button is plain.
//
// What is real here and what is not:
// - The one-time token is minted by `create_enrollment_token` when the step
//   opens, shown once, and printed into the enroll command. It is the token the
//   installer would embed.
// - No signed installer package is published per operating system, so the
//   package line says so and Download for <OS> answers with the command that
//   enrolls the host the same way, instead of a file that does not exist.
// - The tier ladder names the tiers as words. This agent's rung is `harness`,
//   what a hook-based wrap records; the run records its own tier per run.
// - The SDK credential shows the prefix of the agent's live credential, never
//   the secret.
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { advanceOnboarding, issueEnrollmentToken } from "../actions";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { GateFooter, GateHeader } from "./gate-shell";

export type WrapAgentFacts = {
  id: string;
  /** `org_ns.ws_ns.slug`; null when the agent's namespaces cannot be read. */
  key: string | null;
  harness: string;
  /** The live credential's prefix; null when none is live. */
  credentialPrefix: string | null;
};

const TABS = ["cc", "codex", "sdk"] as const;
type Tab = (typeof TABS)[number];
const OSES = ["macos", "windows", "linux"] as const;
type Os = (typeof OSES)[number];
const LANGS = ["ts", "py", "go"] as const;
type Lang = (typeof LANGS)[number];

/** The tab a registered harness opens on. Cursor and Stella enrol through the same host installer as Claude Code. */
export function tabFor(harness: string): Tab {
  if (harness === "codex") return "codex";
  if (harness === "claude-code" || harness === "cursor" || harness === "stella")
    return "cc";
  return "sdk";
}

/** The `--harness` value the enroll command carries on a host tab. */
function hostHarness(tab: Tab, harness: string): string {
  if (tab === "codex") return "codex";
  return harness === "cursor" || harness === "stella" ? harness : "claude-code";
}

const INSTALL: Record<Lang, string> = {
  ts: "npm i @oxagen/sdk",
  py: "pip install oxagen",
  go: "go get github.com/oxagen/oxagen-go",
};

/** The five lines, with this agent's key; a key the record cannot name stays a placeholder. */
export function fiveLines(lang: Lang, key: string): string {
  switch (lang) {
    case "ts":
      return `import { oxagen } from "@oxagen/sdk";\nconst agent = oxagen.agent.wrap({\n  key: "${key}",\n  token: process.env.OXAGEN_AGENT_TOKEN,\n});`;
    case "py":
      return `from oxagen import oxagen\nagent = oxagen.agent.wrap(\n    key="${key}",\n    token=os.environ["OXAGEN_AGENT_TOKEN"],\n)`;
    case "go":
      return `import "github.com/oxagen/oxagen-go"\nagent := oxagen.Agent.Wrap(oxagen.WrapOptions{\n    Key:   "${key}",\n    Token: os.Getenv("OXAGEN_AGENT_TOKEN"),\n})`;
  }
}

type Token = { token: string; expiresAt: string; minutes: number };

function TabList<T extends string>({
  id,
  label,
  items,
  value,
  onChange,
  render,
  className,
}: {
  /** Prefix of each tab's id, so a panel can name the tab that labels it. */
  id: string;
  label: string;
  items: readonly T[];
  value: T;
  onChange: (next: T) => void;
  render: (item: T) => ReactNode;
  className: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={className}>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          id={`${id}-${item}`}
          aria-selected={value === item}
          tabIndex={value === item ? 0 : -1}
          onClick={() => {
            onChange(item);
          }}
          onKeyDown={(e) => {
            const at = items.indexOf(item);
            const step =
              e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (step === 0) return;
            e.preventDefault();
            const next = items[(at + step + items.length) % items.length];
            if (next !== undefined) onChange(next);
          }}
          className="min-h-11 min-w-0 flex-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {render(item)}
        </button>
      ))}
    </div>
  );
}

const segmented =
  "flex rounded-lg border border-border bg-hl p-0.5 text-[12.5px] [&>button]:rounded-md [&>button]:px-2 [&>button]:text-muted-foreground [&>button[aria-selected=true]]:bg-card [&>button[aria-selected=true]]:text-foreground [&>button[aria-selected=true]]:shadow-sm";

function Ladder({ observe }: { observe: boolean }) {
  const t = useTranslations("onboarding.welcome.wrap.ladder");
  const rows: [string, string, boolean][] = [
    [t("thisAgent"), "harness", observe],
    [t("next"), "gateway", false],
    [t("top"), "contained", false],
  ];
  return (
    <dl
      data-testid="tier-ladder"
      className="overflow-hidden rounded-lg border border-border text-[13px]"
    >
      {rows.map(([label, tier, orObserve]) => (
        <div
          key={tier}
          className="flex items-center justify-between gap-2 border-border px-3 py-2.5 not-last:border-b"
        >
          <dt>{label}</dt>
          <dd className="flex items-center gap-1.5">
            <Badge tone="quiet" dot={false} mono data-tier={tier}>
              {tier}
            </Badge>
            {orObserve ? (
              <Badge tone="quiet" dot={false} data-tier="observe">
                {t("orObserve")}
              </Badge>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TokenBox({
  token,
  minting,
  failure,
  onRetry,
  noAgent,
}: {
  token: Token | null;
  minting: boolean;
  failure: string | null;
  onRetry: () => void;
  noAgent: ReactNode | null;
}) {
  const t = useTranslations("onboarding.welcome.wrap");
  if (noAgent !== null) return <>{noAgent}</>;
  return (
    <div
      data-testid="enrollment-token"
      className="rounded-lg border border-dashed border-border bg-hl px-3 py-2.5 font-mono text-[11.5px] leading-relaxed"
    >
      <span className="text-foreground">{t("tokenEmbedded")}</span>
      <br />
      {token === null ? (
        <span className="text-muted-foreground">
          {minting ? t("tokenMinting") : null}
        </span>
      ) : (
        <>
          <b
            data-testid="enrollment-token-value"
            className="break-all font-semibold text-accent-text"
          >
            {token.token}
          </b>
          <br />
          <span className="text-muted-foreground">
            {t("tokenExpires", { minutes: token.minutes })}
          </span>
        </>
      )}
      {failure === null ? null : (
        <span className="mt-2 flex flex-col gap-2 font-sans">
          <FormAlert testId="wrap-token-failure">{failure}</FormAlert>
          <button
            type="button"
            onClick={onRetry}
            className={`${buttonSecondary} self-start`}
          >
            {t("tokenAgain")}
          </button>
        </span>
      )}
    </div>
  );
}

export function WrapStep({
  org,
  ws,
  agent,
  gated,
  back,
  cancel,
  register,
  next,
}: {
  org: string;
  ws: string;
  /** The agent this step wraps; null when the workspace has none to wrap. */
  agent: WrapAgentFacts | null;
  /** True while this workspace carries the organization's open gate. */
  gated: boolean;
  back: SafePath;
  cancel: SafePath;
  /** Where an agent is registered when there is none. */
  register: SafePath;
  /** Start a run, for the same agent. */
  next: SafePath;
}) {
  const t = useTranslations("onboarding.welcome.wrap");
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>(() =>
    tabFor(agent?.harness ?? "claude-code"),
  );
  const [os, setOs] = useState<Os>("macos");
  const [lang, setLang] = useState<Lang>("ts");
  const [token, setToken] = useState<Token | null>(null);
  const [minting, setMinting] = useState(false);
  const [tokenFailure, setTokenFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceFailure, setAdvanceFailure] = useState<string | null>(null);
  const mintedRef = useRef(false);
  const agentId = agent?.id ?? null;

  const mint = useCallback(async () => {
    if (agentId === null) return;
    setMinting(true);
    setTokenFailure(null);
    try {
      const result = await issueEnrollmentToken(org, ws, agentId);
      if (result.ok) {
        const minutes = Math.max(
          1,
          Math.round(
            (Date.parse(result.value.expiresAt) - Date.now()) / 60_000,
          ),
        );
        setToken({
          token: result.value.token,
          expiresAt: result.value.expiresAt,
          minutes,
        });
      } else setTokenFailure(failureText(result));
    } catch {
      setTokenFailure(failureText(UNANSWERED));
    } finally {
      setMinting(false);
    }
  }, [agentId, org, ws, failureText]);

  // The token is the step's content, so it is minted when the step opens, once
  // per visit: it is single use and expires unused, so a reload mints another
  // rather than showing one nobody can read back. The mint runs off a timer so
  // a development double mount, which cancels the first, still mints once.
  useEffect(() => {
    if (mintedRef.current || agentId === null) return;
    const timer = setTimeout(() => {
      mintedRef.current = true;
      void mint();
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [agentId, mint]);

  async function advance(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (advancing) return;
    setAdvancing(true);
    setAdvanceFailure(null);
    try {
      if (gated) {
        const result = await advanceOnboarding(org, ws, "run");
        if (!result.ok) {
          setAdvanceFailure(failureText(result));
          return;
        }
      }
      navigate.push(next);
    } catch {
      setAdvanceFailure(failureText(UNANSWERED));
    } finally {
      setAdvancing(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t("copied"));
    } catch {
      setStatus(t("copyFailed"));
    }
  }

  const monoChunk = (chunks: ReactNode) => (
    <span className={mono}>{chunks}</span>
  );
  const key = agent?.key ?? null;
  const noAgent =
    agent === null ? (
      <div
        data-testid="wrap-no-agent"
        className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-[13px]"
      >
        <p className="font-semibold text-foreground">{t("noAgentTitle")}</p>
        <p className="text-muted-foreground">{t("noAgentBody")}</p>
        <SafeLink to={register} className={`${buttonSecondary} self-start`}>
          {t("noAgentAction")}
        </SafeLink>
      </div>
    ) : null;
  const command =
    token === null || agent === null
      ? null
      : `oxagen agent enroll --token ${token.token} --harness ${hostHarness(tab, agent.harness)}`;

  const downloadColumn = (profile: boolean) => (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-3.5">
      <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {t("download")}
      </p>
      <TabList
        id="wrap-os"
        label={t("osLabel")}
        items={OSES}
        value={os}
        onChange={setOs}
        render={(o) => t(`os.${o}`)}
        className={segmented}
      />
      <button
        type="button"
        data-testid="wrap-download"
        className={`${buttonPrimary} w-full`}
        onClick={() => {
          setStatus(t("downloadNotBacked", { os: t(`os.${os}`) }));
        }}
      >
        {t("downloadFor", { os: t(`os.${os}`) })}
      </button>
      <p
        data-testid="wrap-package-not-backed"
        className="font-mono text-[11px] leading-relaxed text-muted-foreground"
      >
        {t("packageNotBacked")}
        {profile ? (
          <>
            <br />
            {t("profile")}
          </>
        ) : null}
      </p>
      <TokenBox
        token={token}
        minting={minting}
        failure={tokenFailure}
        onRetry={() => void mint()}
        noAgent={noAgent}
      />
      {command === null ? null : (
        <>
          <span className="text-xs text-muted-foreground">{t("orRun")}</span>
          <pre
            data-testid="wrap-enroll-command"
            className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-[12px]"
          >
            {command}
          </pre>
        </>
      )}
    </div>
  );

  let body: ReactNode;
  if (tab === "cc") {
    body = (
      <>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            {t("tabs.cc.name")}{" "}
            <Badge tone="allowed" dot={false}>
              {t("recommended")}
            </Badge>
          </h3>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t.rich("ccBody", { mono: monoChunk })}
          </p>
          <Ladder observe={false} />
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t("ccTier")}
          </p>
        </div>
        {downloadColumn(false)}
      </>
    );
  } else if (tab === "codex") {
    body = (
      <>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="text-[15px] font-semibold">{t("tabs.codex.name")}</h3>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t.rich("codexBody", { mono: monoChunk })}
          </p>
          <Ladder observe />
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t("codexTier")}
          </p>
        </div>
        {downloadColumn(true)}
      </>
    );
  } else {
    const lines = fiveLines(lang, key ?? "<agent key>");
    body = (
      <>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="text-[15px] font-semibold">{t("tabs.sdk.name")}</h3>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t.rich("sdkBody", { mono: monoChunk })}
          </p>
          <Ladder observe={false} />
        </div>
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-3.5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {t("credential")}
          </p>
          {noAgent ?? (
            <div
              data-testid="wrap-credential"
              className="rounded-lg border border-dashed border-border bg-hl px-3 py-2.5 font-mono text-[11.5px] leading-relaxed"
            >
              {t("credentialIssued")}
              <br />
              <b className="font-semibold text-accent-text">
                {agent?.credentialPrefix == null
                  ? t("credentialNone")
                  : t("credentialValue", { prefix: agent.credentialPrefix })}
              </b>
              <br />
              <span className="text-muted-foreground">
                {t("credentialFacts")}
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t.rich("credentialBody", { mono: monoChunk })}
          </p>
          <pre className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-[12px]">
            <span className="text-muted-foreground">$ </span>
            {INSTALL[lang]}
          </pre>
        </div>
        <div className="flex min-w-0 flex-col gap-3 md:col-span-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <TabList
              id="wrap-lang"
              label={t("langLabel")}
              items={LANGS}
              value={lang}
              onChange={setLang}
              render={(l) => t(`lang.${l}`)}
              className={`${segmented} max-w-[300px] flex-1`}
            />
            <button
              type="button"
              className={`${buttonSecondary} md:ml-auto`}
              onClick={() => void copy(lines)}
            >
              {t("copy")}
            </button>
          </div>
          <pre
            data-testid="wrap-five-lines"
            className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-[12px]"
          >
            {lines}
          </pre>
        </div>
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <GateHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        lead={
          key === null ? t("leadNoKey") : t.rich("lead", { key, k: monoChunk })
        }
      />
      <div className={panel}>
        <TabList
          id="wrap-tab"
          label={t("tabsLabel")}
          items={TABS}
          value={tab}
          onChange={setTab}
          render={(item) => (
            <span className="flex flex-col items-start gap-0.5 px-3.5 py-3 text-left">
              <span className="text-[14px] font-semibold text-foreground">
                {t(`tabs.${item}.name`)}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {t(`tabs.${item}.sub`)}
              </span>
            </span>
          )}
          className="flex border-b border-border max-sm:flex-col [&>button]:border-border [&>button:not(:last-child)]:border-r max-sm:[&>button:not(:last-child)]:border-r-0 max-sm:[&>button:not(:last-child)]:border-b [&>button[aria-selected=true]]:bg-hl [&>button[aria-selected=true]]:shadow-[inset_0_-2px_0_var(--accent-text)]"
        />
        <section
          role="tabpanel"
          aria-labelledby={`wrap-tab-${tab}`}
          data-testid="wrap-panel"
          data-tab={tab}
          className="grid grid-cols-1 gap-5 p-[18px] md:grid-cols-2"
        >
          {body}
        </section>
        <p
          role="status"
          data-testid="wrap-status"
          className="px-[18px] pb-3 text-sm text-foreground empty:hidden"
        >
          {status}
        </p>
      </div>
      {advanceFailure === null ? null : (
        <FormAlert testId="advance-failure">{advanceFailure}</FormAlert>
      )}
      <GateFooter
        start={
          <>
            <SafeLink to={cancel} className={buttonSecondary}>
              {t("cancel")}
            </SafeLink>
            <SafeLink to={back} className={buttonSecondary}>
              {t("back")}
            </SafeLink>
          </>
        }
        caption={t("caption")}
        end={
          <form onSubmit={(e) => void advance(e)} className="max-md:w-full">
            <SubmitButton
              pending={advancing}
              label={t("continue")}
              pendingLabel={t("advancing")}
              fullWidth={false}
              secondary
              className="max-md:w-full"
            />
          </form>
        }
      />
    </div>
  );
}
