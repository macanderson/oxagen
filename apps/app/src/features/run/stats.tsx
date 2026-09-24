// The Run page's Summary panel and its six-figure stat row (mockup `pRun`,
// `runSummary`, `runStatRow`; spec pages/run.md): Tokens, Prompts, Cost,
// Wasted, Wall clock, Cache hit, one number and one line each.
//
// Each figure is read from the record or left saying why it is missing. The
// spec's Wasted is `runWaste`, the money the corrective turns bought, and no
// store prices that yet (G3, #3892). The box says "not recorded" and its line
// repeats the Prompts box's corrective count, so the two agree. A prompt after
// the first is corrective, and a prompt count read from a transcript that
// stopped short is a floor, and says so.
//
// The Summary panel holds what the spec gives it and nothing more. Summarize
// is offered only where there is no summary yet, as the way in; the workspace
// switch for generated names and summaries sits on the Issues tab.
import { useLocale, useTranslations } from "next-intl";
import type { RunCost, RunTranscript, TokenCounts } from "@/data/contracts/run";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import {
  buttonSecondary,
  eyebrow,
  mono,
  panel,
  statNote,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatDuration, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { useHarness } from "./header";
import { NoValue } from "./parts";
import { SummarizeAction } from "./record-actions";
import { isWhole } from "./whole-transcript";

/** Input is every class the model read: uncached, cache reads and both cache writes. */
export function tokensIn(tokens: TokenCounts): number {
  return (
    tokens.inputUncached +
    tokens.cacheRead +
    tokens.cacheWrite5m +
    tokens.cacheWrite1h
  );
}

/**
 * Output is what the model wrote. The rollup carries reasoning as its own
 * class, subtracted from the vendor's inclusive output figure
 * (packages/telemetry/src/cost-frames.ts), so the two add without counting a
 * token twice.
 */
export function tokensOut(tokens: TokenCounts): number {
  return tokens.output + tokens.reasoning;
}

/** The prompt entries of the whole-run transcript; null when the read failed. */
function promptCount(transcript: Read<RunTranscript>): number | null {
  return transcript.ok
    ? transcript.value.entries.filter((entry) => entry.kinds.includes("prompt"))
        .length
    : null;
}

function Operator({ run }: { run: RunRow }) {
  const t = useTranslations("run");
  if (run.operatorId === null && run.operatorName === null) {
    return <span className="text-muted-foreground">{t("notRecorded")}</span>;
  }
  return (
    <OperatorName
      testId="run-operator-name"
      operator={{
        id: run.operatorId,
        name: run.operatorName,
        kind: run.operatorKind,
      }}
    >
      {run.operatorName ??
        (run.operatorKind === null ? (
          // An id with no name and no kind is still a recorded operator: the
          // id is the label, never "not recorded".
          <span className={mono}>{run.operatorId}</span>
        ) : (
          t(`facts.operatorKind.${run.operatorKind}`)
        ))}
    </OperatorName>
  );
}

export function SummaryPanel({
  run,
  agent,
  org,
  ws,
  orgRole,
}: {
  run: RunRow;
  /** `get_agent` for the run's agent: the harness label the agent card carries. */
  agent: Read<AgentDetail> | null;
  org: string;
  ws: string;
  orgRole: OrgRole;
}) {
  const t = useTranslations("run");
  const harness = useHarness(run, agent)?.name ?? null;
  const format = useFormatter();
  // A workspace that turned automatic summaries off shows none, even one
  // generated before it did (ADR-153).
  const summary = run.enrichmentEnabled === false ? null : run.summary;
  return (
    <section
      aria-labelledby="run-summary-title"
      data-testid="run-summary"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="run-summary-title" className={eyebrow}>
          {t("summary.title")}
        </h2>
        <span className="rounded-md border border-border px-2 py-0.5 text-[10.5px] font-semibold text-muted-foreground">
          {t("summary.generated")}
        </span>
      </div>
      <div
        data-testid="run-involved"
        className="flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        <AgentCard
          agentKey={run.agentKey}
          notRecorded={t("notRecorded")}
          sub={harness ?? t("header.harnessNotRecorded")}
        />
        {/* A wrapped session's operator can be the person who enrolled its
            machine rather than one who started it, and the line says which. */}
        <span className="text-xs text-muted-foreground">
          {run.operatorAttribution === "host_enroller"
            ? t("summary.enrolledBy")
            : t("summary.onBehalfOf")}
        </span>
        <span
          data-testid="run-operator"
          className="flex flex-col text-sm leading-snug"
        >
          <Operator run={run} />
          {/* The spec's "operator · workspace.owner · core-platform". The
              workspace is the one this run was recorded in. The run record
              carries no operator role, so that part says so. */}
          <span
            data-testid="run-operator-role"
            className={`${mono} text-[11px] text-muted-foreground`}
          >
            {t("summary.operator")} ·{" "}
            <span data-gap="operator-role" title={t("summary.roleWhy")}>
              {t("summary.roleNotRecorded")}
            </span>{" "}
            · {ws}
          </span>
        </span>
      </div>
      {summary === null ? (
        // Turning enrichment off stops the generated summary only; the
        // harness title and every recorded fact stay on the page.
        <p className="text-sm text-muted-foreground">
          {run.enrichmentEnabled === false ? t("summaryOff") : t("noSummary")}
        </p>
      ) : (
        <p
          data-testid="generated-summary"
          className="text-[15px] leading-relaxed"
        >
          {summary.text}
        </p>
      )}
      {run.enrichmentError === undefined ? null : (
        <p
          data-testid="run-summary-failed"
          className="text-xs text-muted-foreground"
        >
          {t("summaryFailed", { reason: run.enrichmentError })}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
        {summary === null ? (
          <SummarizeAction
            org={org}
            ws={ws}
            runId={run.id}
            sealed={run.status !== "live"}
            hasSummary={false}
            summarizable={run.canSummarize}
            orgRole={orgRole}
          />
        ) : (
          <span className={`${mono} text-[11px] text-muted-foreground`}>
            {t("summary.generatedBy", {
              model: summary.model,
              when: format.dateTime(new Date(summary.generatedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            })}
          </span>
        )}
        <SafeLink
          to={routes.run(org, ws, run.id, { tab: "transcript" })}
          className={buttonSecondary}
        >
          {t("summary.check")}
        </SafeLink>
      </div>
    </section>
  );
}

function Stat({
  label,
  note,
  tone,
  children,
}: {
  label: string;
  note: React.ReactNode;
  /** The spec's colour for a figure that asks for attention. */
  tone?: "approval" | "critical";
  children: React.ReactNode;
}) {
  return (
    <div className={statTile}>
      <span className={statTerm}>{label}</span>
      <span
        className={`${statValue} min-w-0 truncate ${tone === "approval" ? "text-info" : tone === "critical" ? "text-critical" : ""}`}
      >
        {children}
      </span>
      <span className={statNote}>{note}</span>
    </div>
  );
}

export function StatRow({
  run,
  cost,
  transcript,
  at,
}: {
  run: RunRow;
  cost: Read<RunCost>;
  /** The whole-run transcript the Prompts figure counts from. */
  transcript: Read<RunTranscript>;
  /** The instant a live run's wall clock is read against. */
  at: number;
}) {
  const t = useTranslations("run.stats");
  const tc = useTranslations("run.cost");
  const tr = useTranslations("run");
  const locale = useLocale();
  const rollup = cost.ok ? cost.value.rollup : null;
  const count = (value: number) => formatCount(value, locale);
  const prompts = promptCount(transcript);
  // The page's whole-run read is one page of entries. Past that page, or past
  // the read's frame cap, the prompt count is a floor.
  const cut = transcript.ok && !isWhole(transcript.value);
  const runCost = rollup?.cost ?? run.cost;
  // The rollup's figure wins over the agent's own report. It is an estimate
  // while the rollup was built from an open run, and final once it priced the
  // sealed one. With no rollup yet, the agent's report stands in as an
  // estimate of its own.
  const displayedCost = runCost ?? run.reportedCost ?? null;
  // An open run's figure is an estimate whatever its row says: a row the
  // control plane's idle close sealed reads final until it is rebuilt open
  // (#3980). The estimate is the Cost box's provisional marking, beside its
  // basis.
  const costIsEstimate =
    run.sealedAt === null ||
    (rollup === null
      ? run.costIsEstimate === true
      : rollup.isEstimate === true);
  // A run Oxagen closed for silence has no recorded end: the seal is when the
  // close ran, 12 hours after the last event, so no wall clock is claimed.
  const endUnrecorded = run.sealSource === "idle_timeout";
  const missingRollup = cost.ok && rollup === null ? t("noRollup") : null;
  // Before the rollup has built a row for the run, the session's own sums
  // over its llm_call frames stand in, so a live run shows its tokens too. Those sums
  // are labelled provisional, since the rollup may still reprice or recount.
  const reported = rollup === null ? (run.reportedTokens ?? null) : null;
  const tokens =
    rollup !== null
      ? {
          in: tokensIn(rollup.tokens),
          out: tokensOut(rollup.tokens),
        }
      : reported === null
        ? null
        : {
            in: reported.input + reported.cacheRead + reported.cacheWrite,
            out: reported.output,
          };
  // Keyed on the status, as the header's started line is. An ended run's
  // clock stops at the recorder's end time, falling back to the seal, which
  // is the server's receipt time; an ended run with neither has no clock.
  const ended = run.endedAt ?? run.sealedAt;
  const wall =
    run.status === "live"
      ? at - new Date(run.startedAt).getTime()
      : endUnrecorded || ended === null
        ? null
        : new Date(ended).getTime() - new Date(run.startedAt).getTime();
  return (
    <section
      aria-label={t("label")}
      data-testid="run-stats"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
    >
      <Stat
        label={t("tokens")}
        note={
          tokens === null
            ? missingRollup
            : reported !== null
              ? t("tokensProvisional")
              : t("tokensNote", {
                  in: count(tokens.in),
                  out: count(tokens.out),
                })
        }
      >
        {tokens === null ? <NoValue /> : count(tokens.in + tokens.out)}
      </Stat>
      <Stat
        label={t("prompts")}
        tone={prompts !== null && prompts > 2 ? "approval" : undefined}
        note={
          prompts === null
            ? null
            : cut
              ? t("promptsCut")
              : prompts === 0
                ? t("noPrompt")
                : prompts === 1
                  ? t("oneShot")
                  : t("corrective", { count: prompts - 1 })
        }
      >
        {prompts === null ? (
          <NoValue />
        ) : cut ? (
          `${count(prompts)}+`
        ) : (
          count(prompts)
        )}
      </Stat>
      <Stat
        label={t("cost")}
        note={
          displayedCost === null ? null : (
            <span className={mono}>
              {runCost === null
                ? tr("costReportedProvisional")
                : (runCost.basis ?? tc("basisNotRecorded"))}
              {runCost !== null && costIsEstimate ? (
                <>
                  {" · "}
                  <span data-testid="run-cost-estimate">
                    {tr("costEstimate")}
                  </span>
                </>
              ) : null}
            </span>
          )
        }
      >
        {displayedCost === null ? <NoValue /> : <Money value={displayedCost} />}
      </Stat>
      {/* Wasted is `runWaste`: the money the corrective turns bought and the
          cause the classifier listed (spec pages/run.md). No store prices a
          corrective turn or lists a cause yet (G3, #3892), so the figure is
          not recorded. The line carries the same corrective count the
          Prompts box reads, so the two boxes agree. */}
      <Stat
        label={t("wasted")}
        note={
          prompts === null || cut || prompts < 2 ? (
            <span data-gap="G3">{t("wasteNotRecorded")}</span>
          ) : (
            t("correctivePrompts", { count: prompts - 1 })
          )
        }
      >
        <span data-testid="run-wasted" data-gap="G3" title={t("wasteWhy")}>
          <NoValue />
        </span>
      </Stat>
      <Stat
        label={t("wallClock")}
        note={
          endUnrecorded
            ? t("noEnd")
            : run.status === "live"
              ? t("soFar")
              : t("splitNotRecorded")
        }
      >
        {wall === null ? (
          <NoValue />
        ) : (
          formatDuration(Math.max(0, wall), locale)
        )}
      </Stat>
      <Stat
        label={t("cacheHit")}
        note={missingRollup ?? t("savingNotRecorded")}
      >
        {rollup?.cacheHitRate == null ? (
          <NoValue />
        ) : (
          formatRatio(rollup.cacheHitRate, locale)
        )}
      </Stat>
    </section>
  );
}
