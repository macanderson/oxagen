// Outcomes (agent-work-phase-1.html, Screens: Outcome view; roadmap
// mockups/pages/work-outcomes.md, mockups/src/work.js `outcomesView()`): what
// the workspace's Phase 1 work finished in the window get_work_outcomes reads.
// Six tiles say how much a person accepted and merged, how much came back, how
// much closed and why, how long it took, how often a person touched it, and
// what it cost with the share of runs whose cost oxagen knows. Under them sit
// the weekly trend, the touches by kind, the cost coverage, and the reopens and
// reverts.
//
// The page keeps the spec's rules. Accepted, returned and closed never add up
// into one rate. Lead time names its median, its p90 and its sample. An
// unknown cost stays unknown and never reads as zero. Reopens and reverts count
// only items merged 30 or more days ago. The page says a revert counts only
// when GitHub links it, and a revert made by hand is not counted. In-app
// triage spend is on Billing, outside these figures. No person is named or
// ranked. Nothing on the page writes.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { WorkOutcomes } from "@/data/contracts/work";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  kvList,
  kvTerm,
  kvValue,
  linkText,
  note,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount, formatDecimal } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { StateWrap } from "@/ui/state-wrap";
import { cell, numericCell, Table } from "@/ui/table";
import { WorkReadFailure } from "../read-failure";

function Tile({
  name,
  term,
  value,
  sub,
}: {
  name: string;
  term: string;
  value: ReactNode;
  sub: ReactNode;
}) {
  return (
    <div data-testid={`work-outcome-${name}`} className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={statValue}>{value}</dd>
      <dd className={statNote}>{sub}</dd>
    </div>
  );
}

/** Nothing finished, nothing came back, and no run is in the window. */
function isEmpty(outcomes: WorkOutcomes): boolean {
  const { closed } = outcomes;
  return (
    outcomes.acceptedMerged === 0 &&
    outcomes.returned === 0 &&
    closed.cancelled === 0 &&
    closed.declined === 0 &&
    closed.duplicate === 0 &&
    outcomes.cost.runs === 0
  );
}

function Tiles({ outcomes }: { outcomes: WorkOutcomes }) {
  const t = useTranslations("work.outcomes");
  const cost = useTranslations("work.cost");
  const locale = useLocale();
  const { closed, leadTime, touches } = outcomes;
  const hours = (value: number) =>
    t("hours", { hours: formatDecimal(value, locale) });
  return (
    <dl aria-label={t("tilesLabel")} className={statStrip}>
      <Tile
        name="accepted"
        term={t("accepted")}
        value={formatCount(outcomes.acceptedMerged, locale)}
        sub={t("acceptedNote", { days: outcomes.days })}
      />
      <Tile
        name="returned"
        term={t("returned")}
        value={formatCount(outcomes.returned, locale)}
        sub={t("returnedNote")}
      />
      <Tile
        name="closed"
        term={t("closed")}
        value={formatCount(
          closed.cancelled + closed.declined + closed.duplicate,
          locale,
        )}
        sub={
          <span className="flex flex-wrap gap-x-2.5">
            <span data-closed="cancelled">
              {t("closedCancelled", { count: closed.cancelled })}
            </span>
            <span data-closed="declined">
              {t("closedDeclined", { count: closed.declined })}
            </span>
            <span data-closed="duplicate">
              {t("closedDuplicate", { count: closed.duplicate })}
            </span>
          </span>
        }
      />
      <Tile
        name="lead-time"
        term={t("leadTime")}
        value={
          leadTime.medianHours === null
            ? t("noSample")
            : hours(leadTime.medianHours)
        }
        sub={
          leadTime.medianHours === null
            ? t("noSampleNote")
            : leadTime.p90Hours === null
              ? t("leadSampleNote", { count: leadTime.sample })
              : t("leadNote", {
                  hours: formatDecimal(leadTime.p90Hours, locale),
                  count: leadTime.sample,
                })
        }
      />
      <Tile
        name="touches"
        term={t("touches")}
        value={
          touches.perItem === null
            ? t("noSample")
            : formatDecimal(touches.perItem, locale)
        }
        sub={t("touchesNote")}
      />
      <Tile
        name="cost"
        term={t("cost")}
        value={
          outcomes.cost.runs === 0 ? (
            cost("none")
          ) : outcomes.cost.total === null ? (
            <span data-cost="unknown">{t("costUnknown")}</span>
          ) : (
            <Money value={outcomes.cost.total} />
          )
        }
        sub={
          outcomes.cost.runs === 0
            ? t("costNoRunsNote")
            : t("costNote", {
                known: outcomes.cost.knownRuns,
                runs: outcomes.cost.runs,
              })
        }
      />
    </dl>
  );
}

function WeeklyTrend({ weeks }: { weeks: WorkOutcomes["weeks"] }) {
  const t = useTranslations("work.outcomes");
  const format = useFormatter();
  const locale = useLocale();
  return (
    <section
      aria-labelledby="work-outcomes-weeks-title"
      data-testid="work-outcomes-weeks"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-outcomes-weeks-title" className={panelTitle}>
          {t("weeks.title")}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t("weeks.caption", { count: weeks.length })}
        </span>
      </div>
      {weeks.length === 0 ? (
        <p className={`${panelBody} text-sm text-muted-foreground`}>
          {t("weeks.empty")}
        </p>
      ) : (
        <Table
          label={t("weeks.title")}
          columns={[
            { label: t("weeks.columns.week") },
            { label: t("weeks.columns.accepted"), numeric: true },
            { label: t("weeks.columns.returned"), numeric: true },
            { label: t("weeks.columns.lead"), numeric: true },
          ]}
        >
          {weeks.map((week) => (
            <tr key={week.week} data-week={week.week}>
              <td className={`${cell} whitespace-nowrap`}>
                {format.dateTime(new Date(`${week.week}T00:00:00Z`), {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })}
              </td>
              <td className={numericCell}>
                {formatCount(week.acceptedMerged, locale)}
              </td>
              <td className={numericCell}>
                {formatCount(week.returned, locale)}
              </td>
              <td className={numericCell}>
                {week.medianLeadHours === null
                  ? t("weeks.noLead")
                  : t("hours", {
                      hours: formatDecimal(week.medianLeadHours, locale),
                    })}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}

function TouchKinds({ touches }: { touches: WorkOutcomes["touches"] }) {
  const t = useTranslations("work.outcomes.touchKinds");
  const locale = useLocale();
  const rows = [
    ["briefApprovals", touches.briefApprovals],
    ["acceptances", touches.acceptances],
    ["returns", touches.returns],
    ["triageOverrides", touches.triageOverrides],
    ["triageCorrections", touches.triageCorrections],
  ] as const;
  return (
    <section
      aria-labelledby="work-outcomes-touches-title"
      data-testid="work-outcomes-touches"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-outcomes-touches-title" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <dl className={`${panelBody} ${kvList}`}>
        {rows.map(([kind, count]) => (
          <div key={kind} className="contents" data-touch={kind}>
            <dt className={kvTerm}>{t(kind)}</dt>
            <dd className={kvValue}>{formatCount(count, locale)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function CostCoverage({
  org,
  cost,
}: {
  org: string;
  cost: WorkOutcomes["cost"];
}) {
  const t = useTranslations("work.outcomes.coverage");
  const total = cost.total;
  return (
    <section
      aria-labelledby="work-outcomes-cost-title"
      data-testid="work-outcomes-cost"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-outcomes-cost-title" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <div className={`${panelBody} flex flex-col gap-2 text-sm`}>
        <p>
          {cost.runs === 0
            ? t("noRuns")
            : total === null
              ? t("unknown", { runs: cost.runs })
              : t.rich("recorded", {
                  known: cost.knownRuns,
                  runs: cost.runs,
                  money: () => <Money value={total} />,
                })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t.rich("note", {
            billing: (chunks) => (
              <SafeLink to={routes.billing(org)} className={linkText}>
                {chunks}
              </SafeLink>
            ),
          })}
        </p>
      </div>
    </section>
  );
}

function Reopens({
  reopens,
  reverts,
}: {
  reopens: WorkOutcomes["reopens"];
  reverts: WorkOutcomes["reverts"];
}) {
  const t = useTranslations("work.outcomes.reopens");
  const locale = useLocale();
  return (
    <section
      aria-labelledby="work-outcomes-reopens-title"
      data-testid="work-outcomes-reopens"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-outcomes-reopens-title" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      <div className={`${panelBody} flex flex-col gap-3 text-sm`}>
        <dl className={kvList}>
          <dt className={kvTerm}>{t("cohort")}</dt>
          <dd className={kvValue} data-figure="cohort">
            {formatCount(reopens.cohort, locale)}
          </dd>
          <dt className={kvTerm}>{t("reopened")}</dt>
          <dd className={kvValue} data-figure="reopened">
            {formatCount(reopens.reopened, locale)}
          </dd>
          <dt className={kvTerm}>{t("reverted")}</dt>
          <dd className={kvValue} data-figure="reverted">
            {formatCount(reverts.reverted, locale)}
          </dd>
        </dl>
        <p className="text-sm text-muted-foreground">
          {t("waiting", { count: reopens.waiting })}
        </p>
        <p className="text-sm text-muted-foreground">{t("reverts")}</p>
      </div>
    </section>
  );
}

function OutcomesView({
  org,
  ws,
  wsName,
  read,
}: {
  org: string;
  ws: string;
  wsName: string;
  read: Read<WorkOutcomes>;
}) {
  const t = useTranslations("work.outcomes");
  const pages = useTranslations("pages");
  return (
    <div data-testid="work-outcomes-page" className="flex flex-col gap-4">
      <PageHeader
        eyebrow={wsName}
        title={pages("workOutcomes")}
        description={
          read.ok ? t("description", { days: read.value.days }) : undefined
        }
      />
      {!read.ok ? (
        <WorkReadFailure
          read={read}
          page={pages("workOutcomes")}
          retry={routes.workOutcomes(org, ws)}
        />
      ) : isEmpty(read.value) ? (
        <StateWrap
          tone="neutral"
          testId="work-outcomes-empty"
          title={t("empty.title")}
          actions={
            <SafeLink
              to={routes.workSetup(org, ws, "collectors")}
              className={buttonPrimary}
            >
              {t("empty.action")}
            </SafeLink>
          }
        >
          {t("empty.body")}
        </StateWrap>
      ) : (
        <>
          {read.value.truncated ? (
            <p data-testid="work-outcomes-truncated" className={note}>
              {t("truncated")}
            </p>
          ) : null}
          <Tiles outcomes={read.value} />
          <div className="grid gap-4 lg:grid-cols-split">
            <WeeklyTrend weeks={read.value.weeks} />
            <TouchKinds touches={read.value.touches} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CostCoverage org={org} cost={read.value.cost} />
            <Reopens
              reopens={read.value.reopens}
              reverts={read.value.reverts}
            />
          </div>
        </>
      )}
    </div>
  );
}

export async function WorkOutcomesPage({
  ctx,
  source,
}: {
  ctx: WsCtx;
  source: DataSource;
}) {
  const read = await source.work.outcomes(ctx);
  return (
    <OutcomesView
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      wsName={ctx.wsName}
      read={read}
    />
  );
}
