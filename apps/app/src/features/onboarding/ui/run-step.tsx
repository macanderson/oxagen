"use client";
// Onboarding step 5, Start a run (mockup `regRun` in onboard mode): the wait
// for the agent's first frame, then the frame and the run's recorded trust
// words. There is no main-repository panel: the workspace was created with its
// steering repo on step 3 (#4518), so nothing is left to bind here.
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
import type { FirstFrame } from "@/data/contracts/onboarding";
import type { EnforcementTier, ReplayGrade } from "@/data/contracts/runs";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonPrimary, buttonSecondary, mono, panel } from "@/ui/control-styles";
import { Button } from "@/ui/button";
import { useFormatter } from "@/ui/formatter";
import { HarnessIcon } from "@/ui/harness-icon";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { GateFooter, GateHeader } from "./gate-shell";
import type { WrapAgentFacts } from "./wrap-step";

/**
 * Seconds the received card waits before it opens Fleet on its own.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
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

const cardHeader =
  "flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3";

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
        <h3 className="text-base font-semibold">{t("waitingTitle")}</h3>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
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
            <HarnessIcon harness={agent.harness} size={14} />
            {harnessName}
          </Badge>
          <Badge tone="quiet" dot={false}>
            {host === null ? t("noHostChip") : t("hostChip")}
          </Badge>
        </div>
        <div
          data-testid="first-frame-log"
          className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-sm leading-relaxed"
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
              className="whitespace-normal py-1 font-sans text-sm text-muted-foreground"
            >
              {t("log.notBacked")}
            </p>
          )}
          <div className="flex gap-3">
            <span className="w-20 flex-none" />
            <span className="text-muted-foreground">{t("log.waiting")}</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
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
        <h3 className="text-base font-semibold">{t("receivedTitle")}</h3>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {time(received.receivedAt)}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {received.frames === null ? (
          <p className="text-base text-muted-foreground">
            {t("framesNotRecorded")}
          </p>
        ) : (
          <div
            data-testid="first-frame-rows"
            className="overflow-x-auto rounded-lg border border-border font-mono text-sm"
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
          <p className="text-sm leading-relaxed text-muted-foreground">
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

export function RunStep({
  fleet,
  back,
  installer,
  register,
  pollRevision,
  agent,
  host,
  received,
  silentFor,
}: {
  fleet: SafePath;
  back: SafePath;
  installer: SafePath;
  register: SafePath;
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
          <h2 className="text-lg font-semibold">{t("errorTitle")}</h2>
          <p className="text-base leading-relaxed text-muted-foreground">
            {t("errorBody", {
              at: format.dateTime(new Date(host.enrolledAt), {
                timeStyle: "medium",
              }),
              seconds: silentFor,
            })}
          </p>
          <p className="text-base leading-relaxed text-muted-foreground">
            {t.rich("errorFix", { mono: monoChunk })}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {t("errorRequest", { id: host.hostEnrollmentId })}
          </p>
          <Button
            type="button"
            variant="outline" className="self-start"
            onClick={() => {
              setStatus(t("checkedAgain"));
              navigate.refresh();
            }}
          >
            {t("checkAgain")}
          </Button>
          <p role="status" className="text-base empty:hidden">
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
          className={`${panel} flex flex-col gap-2 p-4 text-sm`}
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
