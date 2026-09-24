"use client";
// Onboarding step 3, Start a run (mockup `regRun` in onboard mode with
// `obRepoPanel`): the wait for the agent's first frame, then the frame and the
// run's recorded trust words, and below it the repository the enrolling host
// reported, to bind as the main repo now or later.
//
// The wait is `get_first_frame`'s own long poll: the page re-reads a second
// after each completed read, and the server holds each read open while a host
// is enrolled. There is no Done button; the frame is the completion, and once
// it lands Open Oxagen (or the countdown) goes to Fleet, where the run is.
//
// Every word on the received card is the record's: the tier and replay grade
// the run recorded, and "chain intact" only when the chain walk found no gap.
// A value the record does not hold is left off, never filled in.
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import type {
  DetectedRepository,
  FirstFrame,
} from "@/data/contracts/onboarding";
import type { EnforcementTier, ReplayGrade } from "@/data/contracts/runs";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { bindMainRepository } from "../actions";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { GateFooter, GateHeader } from "./gate-shell";
import type { WrapAgentFacts } from "./wrap-step";

/** Seconds the received card waits before it opens Fleet on its own. */
export const COUNTDOWN_SECONDS = 6;

export type ReceivedFrame = {
  runId: string;
  receivedAt: string;
  /** The run's first two frames; null when the run could not be read. */
  frames: { seq: string; at: string; type: string; summary: string }[] | null;
  tier: EnforcementTier | null;
  replayGrade: ReplayGrade | null;
  /** True when the chain walk found no gap; null when it could not be read. */
  chainIntact: boolean | null;
};

type Repository = {
  detected: DetectedRepository | null;
  until: string;
  /** Whole days left in the provisional window, counted by the server at render. */
  daysLeft: number;
  boundAt: string | null;
};

const cardHeader =
  "flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3";

function GitHubGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 .4a7.6 7.6 0 0 0-2.4 14.8c.38.07.52-.16.52-.36v-1.3c-2.1.46-2.55-1-2.55-1-.35-.88-.85-1.12-.85-1.12-.7-.47.05-.46.05-.46.77.06 1.17.79 1.17.79.68 1.17 1.79.83 2.23.64.07-.5.27-.83.48-1.03-1.68-.19-3.45-.84-3.6-3.73 0-.82.3-1.5.77-2.02-.08-.19-.33-.96.07-2 0 0 .63-.2 2.07.77a7.1 7.1 0 0 1 3.77 0c1.44-.97 2.07-.77 2.07-.77.4 1.04.15 1.81.07 2 .48.52.77 1.2.77 2.02 0 2.9-1.77 3.53-3.46 3.72.28.24.52.7.52 1.42v2.1c0 .2.14.44.52.36A7.6 7.6 0 0 0 8 .4z" />
    </svg>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3.5 animate-spin rounded-full border-2 border-border border-t-accent-text motion-reduce:animate-none"
    />
  );
}

function Waiting({
  agent,
  host,
}: {
  agent: WrapAgentFacts;
  host: FirstFrame["host"];
}) {
  const t = useTranslations("onboarding.welcome.run");
  const harness = useTranslations("agents.harness");
  const format = useFormatter();
  const time = (instant: string) =>
    format.dateTime(new Date(instant), { timeStyle: "medium" });
  const lines: { at: string; text: string }[] = [];
  if (host !== null) {
    lines.push({
      at: time(host.enrolledAt),
      text: t("log.enrolled", { id: host.hostEnrollmentId }),
    });
    if (host.lastHeartbeatAt !== null)
      lines.push({ at: time(host.lastHeartbeatAt), text: t("log.heartbeat") });
    if (host.hooksOk !== null)
      lines.push({
        at: "",
        text: host.hooksOk ? t("log.hooksOk") : t("log.hooksMissing"),
      });
  }
  const harnessName = isHarnessKey(agent.harness)
    ? harness(agent.harness)
    : agent.harness;
  return (
    <section data-testid="first-frame-waiting" className={panel}>
      <div className={cardHeader}>
        <Spinner />
        <h3 className="text-[14px] font-semibold">{t("waitingTitle")}</h3>
        <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
          {t("polling")}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap gap-1.5">
          {agent.key === null ? null : (
            <Badge tone="quiet" dot={false} mono>
              {agent.key}
            </Badge>
          )}
          <Badge tone="quiet" dot={false}>
            {harnessName}
          </Badge>
          <Badge tone="quiet" dot={false}>
            {host === null ? t("noHostChip") : t("hostChip")}
          </Badge>
        </div>
        <div
          data-testid="first-frame-log"
          className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-[12px] leading-relaxed"
        >
          {lines.map((line) => (
            <div key={line.text} className="flex gap-3 whitespace-nowrap">
              <span className="w-20 flex-none text-muted-foreground">
                {line.at}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
          {host === null ? null : (
            <p
              data-testid="first-frame-log-not-backed"
              className="whitespace-normal py-1 font-sans text-xs text-muted-foreground"
            >
              {t("log.notBacked")}
            </p>
          )}
          <div className="flex gap-3">
            <span className="w-20 flex-none" />
            <span className="text-muted-foreground">{t("log.waiting")}</span>
          </div>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {host === null
            ? t("startNoHost")
            : t("start", { harness: harnessName })}
        </p>
      </div>
    </section>
  );
}

const HARNESS_KEYS = {
  stella: true,
  "claude-code": true,
  codex: true,
  cursor: true,
  "claude-agent-sdk": true,
  custom: true,
} as const;
type HarnessKey = keyof typeof HARNESS_KEYS;
function isHarnessKey(value: string): value is HarnessKey {
  return Object.hasOwn(HARNESS_KEYS, value);
}

function Received({ received }: { received: ReceivedFrame }) {
  const t = useTranslations("onboarding.welcome.run");
  const format = useFormatter();
  const time = (instant: string) =>
    format.dateTime(new Date(instant), { timeStyle: "medium" });
  return (
    <section data-testid="first-frame-received" className={panel}>
      <div className={cardHeader}>
        <Badge tone="allowed">{t("connected")}</Badge>
        <h3 className="text-[14px] font-semibold">{t("receivedTitle")}</h3>
        <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
          {time(received.receivedAt)}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {received.frames === null ? (
          <p className="text-sm text-muted-foreground">
            {t("framesNotRecorded")}
          </p>
        ) : (
          <div
            data-testid="first-frame-rows"
            className="overflow-x-auto rounded-lg border border-border font-mono text-[12px]"
          >
            {received.frames.map((frame) => (
              <div
                key={frame.seq}
                className="flex gap-3 whitespace-nowrap border-border px-3 py-2 not-last:border-b"
              >
                <span className="text-muted-foreground">{frame.seq}</span>
                <span className="text-muted-foreground">{time(frame.at)}</span>
                <span className="font-semibold">{frame.type}</span>
                <span className="text-muted-foreground">{frame.summary}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {received.tier === null ? null : (
            <Badge tone="quiet" dot={false} mono data-tier={received.tier}>
              {received.tier}
            </Badge>
          )}
          {received.replayGrade === null ? null : (
            <Badge tone="quiet" dot={false}>
              {t("replayGrade", { grade: received.replayGrade })}
            </Badge>
          )}
          {received.chainIntact === true ? (
            <Badge tone="quiet" dot={false}>
              {t("chainIntact")}
            </Badge>
          ) : null}
        </div>
        {received.tier === null ? null : (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {received.tier === "harness"
              ? t.rich("tierBodyHarness", { b: bold })
              : t.rich("tierBody", { tier: received.tier, b: bold })}
          </p>
        )}
      </div>
    </section>
  );
}

function bold(chunks: ReactNode) {
  return <b className="font-semibold text-foreground">{chunks}</b>;
}

function monoChunk(chunks: ReactNode) {
  return <span className={mono}>{chunks}</span>;
}

function RepositoryPanel({
  org,
  ws,
  workspace,
  repository,
  waiting,
  onStatus,
}: {
  org: string;
  ws: string;
  workspace: string;
  repository: Repository;
  /** True while the first frame has not arrived: Bind is the screen's gold action. */
  waiting: boolean;
  onStatus: (text: string) => void;
}) {
  const t = useTranslations("onboarding.welcome.run.repo");
  const format = useFormatter();
  const failureText = useOnboardingFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [bound, setBound] = useState<{
    fullName: string;
    defaultRef: string | null;
  } | null>(() =>
    repository.boundAt === null || repository.detected === null
      ? null
      : {
          fullName: `${repository.detected.owner}/${repository.detected.name}`,
          defaultRef: null,
        },
  );
  const [skipped, setSkipped] = useState(false);
  const detected = repository.detected;
  const fullName =
    detected === null ? null : `${detected.owner}/${detected.name}`;
  const until = format.dateTime(new Date(repository.until), {
    dateStyle: "medium",
  });

  async function bind() {
    if (pending || detected === null || fullName === null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await bindMainRepository(org, ws, {
        owner: detected.owner,
        name: detected.name,
      });
      if (result.ok) {
        setBound({
          fullName: result.value.fullName,
          defaultRef: result.value.defaultRef,
        });
        setSkipped(false);
        onStatus(t("boundToast", { repository: result.value.fullName }));
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const bindButton = (label: string, gold: boolean) => (
    <button
      type="button"
      data-testid="bind-main-repo"
      aria-disabled={pending || undefined}
      onClick={() => void bind()}
      className={`${gold ? buttonPrimary : buttonSecondary} self-start`}
    >
      <GitHubGlyph />
      <span>{pending ? t("binding") : label}</span>
    </button>
  );
  const alert =
    failure === null ? null : (
      <FormAlert testId="bind-failure">{failure}</FormAlert>
    );

  if (bound !== null)
    return (
      <section data-testid="repo-bound" className={panel}>
        <div className={cardHeader}>
          <Badge tone="allowed">{t("bound")}</Badge>
          <h3 className="text-[14px] font-semibold">{t("boundTitle")}</h3>
        </div>
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="quiet" dot={false} mono>
              {bound.fullName}
            </Badge>
            {bound.defaultRef === null ? null : (
              <Badge tone="quiet" dot={false}>
                {t("branch", { branch: bound.defaultRef })}
              </Badge>
            )}
            <Badge tone="allowed">{t("appInstalled")}</Badge>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t.rich("boundBody", {
              repository: bound.fullName,
              mono: monoChunk,
            })}
          </p>
        </div>
      </section>
    );

  if (detected === null || fullName === null)
    return (
      <section data-testid="repo-none" className={panel}>
        <div className={cardHeader}>
          <Badge tone="denied" dot={false}>
            {t("provisional")}
          </Badge>
          <h3 className="text-[14px] font-semibold">{t("noneTitle")}</h3>
        </div>
        <p className="px-4 py-3.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {t.rich("noneBody", { workspace, until, b: bold })}
        </p>
      </section>
    );

  if (skipped)
    return (
      <section data-testid="repo-skipped" className={panel}>
        <div className={cardHeader}>
          <Badge tone="denied" dot={false}>
            {t("provisional")}
          </Badge>
          <h3 className="text-[14px] font-semibold">{t("skippedTitle")}</h3>
        </div>
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t.rich("skippedBody", {
              workspace,
              until,
              days: repository.daysLeft,
              b: bold,
            })}
          </p>
          {alert}
          {bindButton(t("bindNow", { repository: fullName }), false)}
        </div>
      </section>
    );

  return (
    <section data-testid="repo-detected" className={panel}>
      <div className={cardHeader}>
        <h3 className="text-[14px] font-semibold">{t("detectedTitle")}</h3>
        <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
          {t("reported")}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div>
          <Badge tone="quiet" dot={false} mono>
            {t("remote", { repository: fullName })}
          </Badge>
        </div>
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {t("remoteBody")}
        </p>
        {alert}
        {bindButton(t("bind", { repository: fullName }), waiting)}
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {t.rich("bindBody", { repository: fullName, mono: monoChunk })}
        </p>
        <hr className="border-border" />
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          <button
            type="button"
            data-testid="repo-skip"
            onClick={() => {
              setSkipped(true);
            }}
            className="font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("skip")}
          </button>{" "}
          {t.rich("skipBody", {
            workspace,
            days: repository.daysLeft,
            b: bold,
          })}
        </p>
      </div>
    </section>
  );
}

export function RunStep({
  org,
  ws,
  workspace,
  fleet,
  back,
  installer,
  register,
  repository,
  pollRevision,
  agent,
  host,
  received,
  silentFor,
}: {
  org: string;
  ws: string;
  /** The workspace's slug, as the provisional copy names it. */
  workspace: string;
  fleet: SafePath;
  back: SafePath;
  installer: SafePath;
  register: SafePath;
  /** The gate's provisional window; null for a workspace that is not the gate's. */
  repository: Repository | null;
  /** A new opaque value after every completed server read. */
  pollRevision: string;
  agent: WrapAgentFacts | null;
  host: FirstFrame["host"];
  received: ReceivedFrame | null;
  /** Seconds an enrolled host has been silent, once past the limit; null otherwise. */
  silentFor: number | null;
}) {
  const t = useTranslations("onboarding.welcome.run");
  const wrapT = useTranslations("onboarding.welcome.wrap");
  const navigate = useNavigate();
  const format = useFormatter();
  const [status, setStatus] = useState<string | null>(null);
  const [left, setLeft] = useState(COUNTDOWN_SECONDS);
  const waiting = received === null && silentFor === null;

  // The wait: one re-read a second after each completed read.
  useEffect(() => {
    if (!waiting || agent === null) return;
    const timer = setTimeout(() => {
      navigate.refresh();
    }, 1_000);
    return () => {
      clearTimeout(timer);
    };
  }, [pollRevision, waiting, agent, navigate]);

  // The countdown once the frame is in: Fleet opens on its own.
  useEffect(() => {
    if (received === null) return;
    const timer = setInterval(() => {
      setLeft((n) => n - 1);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [received]);
  useEffect(() => {
    if (received !== null && left <= 0) navigate.push(fleet);
  }, [left, received, fleet, navigate]);

  const key = agent?.key ?? null;
  const header = (
    <GateHeader
      eyebrow={t("eyebrow")}
      title={t("title")}
      lead={
        key === null ? t("leadNoKey") : t.rich("lead", { key, k: monoChunk })
      }
    />
  );
  const cancel = (
    <SafeLink to={fleet} className={buttonSecondary}>
      {t("cancel")}
    </SafeLink>
  );
  const backLink = (
    <SafeLink to={back} className={buttonSecondary}>
      {t("back")}
    </SafeLink>
  );

  if (silentFor !== null && host !== null)
    return (
      <div className="flex min-w-0 flex-col gap-5">
        {header}
        <section
          data-testid="first-frame-error"
          className={`${panel} flex flex-col gap-2.5 p-5`}
        >
          <h2 className="text-[17px] font-semibold">{t("errorTitle")}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("errorBody", {
              at: format.dateTime(new Date(host.enrolledAt), {
                timeStyle: "medium",
              }),
              seconds: silentFor,
            })}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t.rich("errorFix", { mono: monoChunk })}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {t("errorRequest", { id: host.hostEnrollmentId })}
          </p>
          <button
            type="button"
            className={`${buttonSecondary} self-start`}
            onClick={() => {
              setStatus(t("checkedAgain"));
              navigate.refresh();
            }}
          >
            {t("checkAgain")}
          </button>
          <p role="status" className="text-sm empty:hidden">
            {status}
          </p>
        </section>
        <GateFooter
          start={
            <>
              {cancel}
              {backLink}
            </>
          }
        />
      </div>
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {agent === null ? (
        <section
          data-testid="wrap-no-agent"
          className={`${panel} flex flex-col gap-2 p-4 text-[13px]`}
        >
          <h3 className="font-semibold">{wrapT("noAgentTitle")}</h3>
          <p className="text-muted-foreground">{wrapT("noAgentBody")}</p>
          <SafeLink to={register} className={`${buttonSecondary} self-start`}>
            {wrapT("noAgentAction")}
          </SafeLink>
        </section>
      ) : received === null ? (
        <Waiting agent={agent} host={host} />
      ) : (
        <Received received={received} />
      )}
      {repository === null ? null : (
        <RepositoryPanel
          org={org}
          ws={ws}
          workspace={workspace}
          repository={repository}
          waiting={received === null}
          onStatus={setStatus}
        />
      )}
      <p
        role="status"
        data-testid="run-status"
        className="text-sm empty:hidden"
      >
        {status}
      </p>
      {received === null ? (
        <GateFooter
          start={
            <>
              {cancel}
              {backLink}
            </>
          }
          caption={t("noDone")}
          end={
            <SafeLink
              to={installer}
              className={`${buttonSecondary} border-transparent bg-transparent`}
            >
              {t("openInstaller")}
            </SafeLink>
          }
        />
      ) : (
        <GateFooter
          start={cancel}
          caption={
            <span id="regAuto">{t("opening", { n: Math.max(left, 0) })}</span>
          }
          end={
            <SafeLink to={fleet} className={buttonPrimary}>
              {t("openOxagen")}
            </SafeLink>
          }
        />
      )}
    </div>
  );
}
