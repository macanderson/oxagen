// The Run page's Summary and its six figures (mockup `runSummary` and
// `runStatRow`, pages/run.md): first in the main column, then one row of stat
// boxes, Tokens, Prompts, Cost, Wasted, Wall clock and Cache hit, each with
// one number and one line.
//
// Every figure comes from `runMetrics`, the one derivation the Cost and
// Context tabs read too, so no two panels can disagree. A figure the record
// does not carry reads "not recorded", never a zero.
import { useLocale, useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { AgentCard } from "@/ui/agent-card";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Clock } from "@/ui/clock";
import {
  buttonSecondary,
  eyebrowQuiet,
  runStatNote,
  runStatStrip,
  runStatTerm,
  runStatTile,
  runStatValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatDuration, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { OperatorName } from "@/ui/operator";
import { EnrichmentSwitch } from "./enrichment-switch";
import { useHarness } from "./header";
import type { RunMetrics } from "./metrics";
import { NoValue } from "./parts";
import { SummarizeAction } from "./record-actions";
import type { Place } from "./tab-props";

/** Two letters from a name, first letters of its first two words; "?" for none. */
function initialsOf(name: string | null): string {
  const letters = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2)
    .map((word) => word[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** `.inv`: the agent that acted, carrying the operator's authority. */
function Involved({
  run,
  agent,
}: {
  run: RunRow;
  agent: Read<AgentDetail> | null;
}) {
  const t = useTranslations("run");
  const harness = useHarness(run, agent);
  const name = agent?.ok === true ? agent.value.identity.name : null;
  const sub = [name, harness?.name ?? null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const hasOperator = run.operatorId !== null || run.operatorName !== null;
  return (
    <div
      data-testid="run-involved"
      className="mt-2.5 flex flex-wrap items-center gap-2.5"
    >
      <AgentCard
        layout="compact"
        agentKey={run.agentKey}
        notRecorded={t("notRecorded")}
        sub={sub === "" ? t("header.harnessNotRecorded") : sub}
      />
      <span className="font-mono text-[11.5px] text-dim">
        {t("summary.onBehalfOf")}
      </span>
      <span
        data-testid="run-operator"
        className="inline-flex min-w-0 max-w-full items-center gap-[9px] rounded-full border border-border bg-background py-[5px] pl-1.5 pr-3 text-[12.5px] text-foreground"
      >
        {hasOperator ? (
          <Avatar
            value={null}
            initials={initialsOf(run.operatorName)}
            size={30}
          />
        ) : null}
        {hasOperator ? (
          <OperatorName
            testId="run-operator-name"
            operator={{
              id: run.operatorId,
              name: run.operatorName,
              kind: run.operatorKind,
            }}
          >
            <span className="flex min-w-0 flex-col leading-tight">
              <b className="truncate font-semibold">
                {run.operatorName ??
                  (run.operatorKind === null ? (
                    // An id with no name and no kind is still a recorded
                    // operator: the id is the label, never "not recorded".
                    <span className="font-mono">{run.operatorId}</span>
                  ) : (
                    t(`facts.operatorKind.${run.operatorKind}`)
                  ))}
              </b>
              <span className="truncate font-mono text-[10.5px] text-dim">
                {/* A wrapped session's operator can be the person who
                    enrolled the host rather than one who started the run,
                    and the record says which. */}
                {run.operatorAttribution === "host_enroller"
                  ? t("header.enrolledBy")
                  : t("summary.operator")}
              </span>
            </span>
          </OperatorName>
        ) : (
          <span className="text-muted-foreground">{t("notRecorded")}</span>
        )}
      </span>
    </div>
  );
}

export function SummaryPanel({
  run,
  agent,
  place,
  orgRole,
  canEditEnrichment,
}: {
  run: RunRow;
  agent: Read<AgentDetail> | null;
  place: Place;
  orgRole: OrgRole;
  /** An org or workspace Owner or Admin may turn automatic summaries on or off. */
  canEditEnrichment: boolean;
}) {
  const t = useTranslations("run");
  const format = useFormatter();
  const summary = run.enrichmentEnabled === false ? null : run.summary;
  return (
    <section
      aria-labelledby="run-summary-title"
      data-testid="run-summary"
      className="rounded-xl border border-border bg-card px-[18px] py-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="run-summary-title" className={`${eyebrowQuiet} m-0`}>
          {t("summary.title")}
        </h2>
        <Badge tone="quiet" dot={false}>
          <span className="text-[10.5px]">{t("summary.generated")}</span>
        </Badge>
      </div>
      <Involved run={run} agent={agent} />
      {summary === null ? (
        <p className="mb-2.5 mt-3 max-w-[78ch] text-sm text-muted-foreground">
          {t("noSummary")}
        </p>
      ) : (
        <p
          data-testid="generated-summary"
          className="mb-2.5 mt-3 max-w-[78ch] text-[15px] leading-[1.55] text-foreground"
        >
          {summary.text}
        </p>
      )}
      {run.enrichmentError === undefined ? null : (
        <p
          data-testid="run-summary-failed"
          className="mb-2.5 text-xs text-muted-foreground"
        >
          {t("summaryFailed", { reason: run.enrichmentError })}
        </p>
      )}
      <div className="mt-[13px] flex flex-wrap items-center gap-2.5 border-t border-border pt-[11px] font-mono text-[11px] text-dim">
        <span className="min-w-0 flex-1">
          {summary === null ? (
            t("summary.notGenerated")
          ) : (
            <>
              {t("summary.generatedBy")}{" "}
              <b className="font-semibold text-muted-foreground">
                {summary.model}
              </b>{" "}
              ·{" "}
              <time dateTime={summary.generatedAt}>
                {format.dateTime(new Date(summary.generatedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </>
          )}
        </span>
        <SummarizeAction
          org={place.org}
          ws={place.ws}
          runId={run.id}
          sealed={run.status !== "live"}
          hasSummary={run.summary !== null}
          summarizable={run.canSummarize}
          orgRole={orgRole}
        />
        <SafeLink
          to={routes.run(place.org, place.ws, run.id, { tab: "actions" })}
          className={`${buttonSecondary} min-h-7 px-2.5 font-mono text-xs`}
        >
          {t("summary.check")}
        </SafeLink>
      </div>
      <div className="mt-2">
        <EnrichmentSwitch
          org={place.org}
          ws={place.ws}
          enabled={run.enrichmentEnabled !== false}
          canEdit={canEditEnrichment}
          compact
        />
      </div>
    </section>
  );
}

/** `.rstats .stat`: one term, one figure and one line. */
function Stat({
  label,
  note,
  tone,
  testId,
  children,
}: {
  label: string;
  note?: React.ReactNode;
  /** The figure's colour, where the design gives one: approval above two prompts, critical above zero waste. */
  tone?: "approval" | "critical";
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className={runStatTile}>
      <span className={runStatTerm}>{label}</span>
      <span
        className={`${runStatValue} ${tone === "approval" ? "text-info" : tone === "critical" ? "text-critical" : ""}`}
      >
        {children}
      </span>
      {note === undefined ? null : <span className={runStatNote}>{note}</span>}
    </div>
  );
}

export function StatRow({
  run,
  metrics,
}: {
  run: RunRow;
  metrics: RunMetrics;
}) {
  const t = useTranslations("run.stats");
  const locale = useLocale();
  const count = (value: number) => formatCount(value, locale);
  const { tokens, prompts, wall, priced } = metrics;
  // A count read from a transcript that stopped short of the run is a floor.
  const floor = metrics.whole ? "" : "+";
  const displayedCost = metrics.cost ?? run.reportedCost ?? null;
  const wastedPositive =
    metrics.wasted !== null && metrics.wasted.micros !== "0";
  return (
    <section
      aria-label={t("label")}
      data-testid="run-stats"
      className={`${runStatStrip} my-3`}
    >
      <Stat
        testId="run-stat-tokens"
        label={t("tokens")}
        note={
          tokens !== null
            ? t("tokensNote", {
                input: count(tokens.input),
                output: count(tokens.output),
              })
            : // Before the rollup rebuilds the run, the session's own sums
              // stand in, labelled provisional.
              metrics.reportedTokens !== null
              ? t("tokensProvisional")
              : t("noRollup")
        }
      >
        {tokens !== null ? (
          count(tokens.total)
        ) : metrics.reportedTokens !== null ? (
          count(metrics.reportedTokens.total)
        ) : (
          <NoValue />
        )}
      </Stat>
      <Stat
        testId="run-stat-prompts"
        label={t("prompts")}
        tone={prompts !== null && prompts.count > 2 ? "approval" : undefined}
        note={
          prompts === null
            ? undefined
            : prompts.count <= 1
              ? t("oneShot")
              : t("corrective", { count: prompts.corrective })
        }
      >
        {prompts === null ? <NoValue /> : `${count(prompts.count)}${floor}`}
      </Stat>
      <Stat
        testId="run-stat-cost"
        label={t("cost")}
        note={
          displayedCost === null ? undefined : (
            <span className="font-mono text-[10.5px] text-dim">
              {metrics.cost === null
                ? t("provisional")
                : metrics.costIsEstimate
                  ? t("estimate")
                  : (metrics.cost.basis ?? t("basisNotRecorded"))}
            </span>
          )
        }
      >
        {displayedCost === null ? <NoValue /> : <Money value={displayedCost} />}
      </Stat>
      <Stat
        testId="run-stat-wasted"
        label={t("wasted")}
        tone={wastedPositive ? "critical" : undefined}
        note={
          metrics.wasted === null
            ? t("noRollup")
            : wastedPositive
              ? t("wastedNote")
              : t("nothingWasted")
        }
      >
        {metrics.wasted === null ? (
          <NoValue />
        ) : (
          <Money value={metrics.wasted} />
        )}
      </Stat>
      <Stat
        testId="run-stat-wall"
        label={t("wallClock")}
        note={
          wall.closedIdle
            ? t("noEnd")
            : wall.lead === null
              ? undefined
              : t(`mostly.${wall.lead}`)
        }
      >
        {wall.ticking !== null ? (
          // A live run's clock keeps counting, once a second, from its start.
          <span data-testid="run-wall-ticking" className="whitespace-nowrap">
            <Clock
              at={wall.ticking.from}
              now={wall.ticking.at}
              direction="since"
              className="tabular-nums"
            />
          </span>
        ) : wall.ms === null ? (
          <NoValue />
        ) : (
          <span className="whitespace-nowrap">
            {formatDuration(wall.ms, locale)}
          </span>
        )}
      </Stat>
      <Stat
        testId="run-stat-cache"
        label={t("cacheHit")}
        note={
          priced?.cacheSaved == null ? undefined : (
            <>
              {t("saved")} <Money value={priced.cacheSaved} />
            </>
          )
        }
      >
        {metrics.cacheHit === null ? (
          <NoValue />
        ) : (
          formatRatio(metrics.cacheHit, locale)
        )}
      </Stat>
    </section>
  );
}
