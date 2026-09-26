// Spend › Findings (#2963, ADR-062; spec "Findings"): the workspace's open
// findings ranked by the money at stake. The hero sums them (Savings
// identified, its share of the window's spend, a year at this run rate, the
// share strip with its legend and the four facts); the list filters, sorts and
// pages them; Evidence opens one finding's arithmetic in a dialog and Fix opens
// the change that removes it. Every figure is the findings job's. The one
// thing computed here is a finding's share of the listed total, divided
// through the micros seam and printed as a ratio (INV-09, INV-10).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { ratioOfMicros } from "@/data/contracts/money";
import type {
  SpendFinding,
  SpendFindingEvidence,
  SpendFindings,
  SpendReport,
} from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { eyebrow, linkText, mono, panel } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { EvidenceDialog } from "./evidence-dialog";
import {
  BasisLabel,
  EstimateBasis,
  Instant,
  MoneyFigure,
  NotRecordedValue,
  Tile,
  TileStrip,
} from "./figures";
import { FindingsList } from "./findings-list";
import { NotBacked } from "./not-backed";
import { Empty, Panel } from "./tables";
import type { SpendAt } from "./view";

/** Findings named in the legend; the rest roll into one entry, since at forty a name per slice is unreadable. */
const LEGEND_MAX = 8;

/** The strip's shading, darkest for the largest saving. */
const RAMP = [1, 0.8, 0.64, 0.5, 0.38, 0.28];

const opacityOf = (index: number): number =>
  RAMP[index % RAMP.length] ?? RAMP[0] ?? 1;

/** Each listed finding's saving over the listed total; null where the total does not divide it. */
function sharesOf(
  findings: readonly SpendFinding[],
  total: SpendFindings["saving"],
): (number | null)[] {
  return findings.map((finding) =>
    total === null ? null : ratioOfMicros(finding.saving, total),
  );
}

/**
 * The composition of the identified savings. A slice's width is layout and
 * never a printed figure; the legend beside it carries the numbers as text.
 */
function CompositionStrip({
  findings,
  shares,
}: {
  findings: readonly SpendFinding[];
  shares: readonly (number | null)[];
}) {
  const t = useTranslations("spend");
  return (
    <div
      role="img"
      aria-label={t("findings.strip.label")}
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      {findings.map((finding, index) => {
        const share = shares[index];
        if (share === null || share === undefined || share <= 0) return null;
        return (
          <span
            key={finding.id}
            data-finding={finding.id}
            className="block h-full bg-link"
            style={{
              width: `${String(Math.round(share * 1000) / 10)}%`,
              opacity: opacityOf(index),
            }}
          />
        );
      })}
    </div>
  );
}

function Legend({
  findings,
  shares,
}: {
  findings: readonly SpendFinding[];
  shares: readonly (number | null)[];
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const tail = findings.slice(LEGEND_MAX);
  const tailShares = shares.slice(LEGEND_MAX);
  const known = tailShares.filter((share): share is number => share !== null);
  const tailShare =
    known.length === tailShares.length
      ? known.reduce((sum, share) => sum + share, 0)
      : null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {findings.slice(0, LEGEND_MAX).map((finding, index) => {
        const share = shares[index];
        return (
          <li key={finding.id} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-sm bg-link"
              style={{ opacity: opacityOf(index) }}
            />
            <span>{t(`findings.kind.${finding.kind}`)}</span>
            <span className="tabular-nums">
              {share === null || share === undefined ? (
                <NotRecordedValue />
              ) : (
                formatRatio(share, locale)
              )}
            </span>
          </li>
        );
      })}
      {tail.length === 0 ? null : (
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 rounded-sm bg-link opacity-20"
          />
          <span>
            {t("findings.strip.tail", {
              count: formatCount(tail.length, locale),
            })}
          </span>
          <span className="tabular-nums">
            {tailShare === null ? (
              <NotRecordedValue />
            ) : (
              formatRatio(tailShare, locale)
            )}
          </span>
        </li>
      )}
    </ul>
  );
}

export function FindingsSection({
  findings,
  operators,
  at,
  evidence,
}: {
  findings: SpendFindings;
  /** The operator rollup, to name the person an operator finding is about. */
  operators: SpendReport["rows"];
  at: SpendAt;
  /** One finding's evidence, open as a dialog over the list; null when none is. */
  evidence: ReactNode;
}) {
  const t = useTranslations("spend.findings");
  const locale = useLocale();
  const shares = sharesOf(findings.findings, findings.saving);
  const names = Object.fromEntries(
    operators.flatMap((row) =>
      row.operator?.name ? [[row.key, row.operator.name] as const] : [],
    ),
  );
  return (
    <>
      <section
        aria-labelledby="spend-findings-hero"
        data-testid="spend-findings-hero"
        className={`${panel} grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]`}
      >
        <div className="flex flex-col gap-1.5">
          <h2 id="spend-findings-hero" className={eyebrow}>
            {t("hero")}
          </h2>
          <span className="text-4xl font-bold tracking-tight tabular-nums">
            <MoneyFigure money={findings.saving} />
          </span>
          <EstimateBasis cost={findings.saving} />
          <p className="text-[12.5px] text-muted-foreground">
            {findings.share === null || findings.spend === null ? (
              <NotRecordedValue />
            ) : (
              <>
                {t("heroShare", {
                  share: formatRatio(findings.share, locale),
                })}{" "}
                <Money value={findings.spend} /> {t("heroWindow")}
              </>
            )}{" "}
            {findings.annualised === null ? null : (
              <>
                {t("heroYearStart")} <Money value={findings.annualised} />{" "}
                {t("heroYearEnd")}
              </>
            )}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {findings.findings.length === 0 ? null : (
            <>
              <CompositionStrip findings={findings.findings} shares={shares} />
              <Legend findings={findings.findings} shares={shares} />
            </>
          )}
          <ul className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-[12.5px] text-muted-foreground">
            <li>
              <b className="text-foreground">
                {formatCount(findings.counts.findings, locale)}
              </b>{" "}
              {t("facts.findings")}
            </li>
            <li>
              <b className="text-foreground">
                {formatCount(findings.counts.operators, locale)}
              </b>{" "}
              {t("facts.operators")}
            </li>
            <li>
              <b className="text-foreground">
                {formatCount(findings.counts.high, locale)}
              </b>{" "}
              {t("facts.high")}{" "}
              <b className="text-foreground">
                {formatCount(findings.counts.medium, locale)}
              </b>{" "}
              {t("facts.medium")}
            </li>
            <li>{t("facts.evidence")}</li>
          </ul>
        </div>
      </section>
      {findings.findings.length === 0 ? (
        <section
          data-state="empty"
          className={`${panel} flex flex-col gap-2 p-6`}
        >
          <h2 className="text-base font-semibold">{t("emptyTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </section>
      ) : (
        <FindingsList
          findings={findings.findings}
          shares={shares}
          names={names}
          at={at}
        />
      )}
      <div className="flex flex-col gap-2 border-l-2 border-gold py-1 pl-3 text-[12.5px] text-muted-foreground">
        <p>{t("note")}</p>
        <NotBacked gap="findings">{t("attributionMissing")}</NotBacked>
      </div>
      {evidence}
    </>
  );
}

/**
 * One finding's evidence as a dialog over the list: the arithmetic the job
 * wrote, the calls the counterfactual covers, and the cited runs. Closing it
 * returns to the page it opened over: the Findings list, or the Run page's
 * Cost tab when a waterfall pin opened it (#4001). A read that did not answer
 * says so inside the dialog.
 */
export function FindingEvidence({
  evidence,
  at,
  close = routes.spend(at.org, at.ws, { tab: "findings" }),
}: {
  evidence: Read<SpendFindingEvidence>;
  at: SpendAt;
  /** Where closing the dialog goes; the Findings list when omitted. */
  close?: SafePath;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  if (!evidence.ok) {
    return (
      <EvidenceDialog title={t("findings.evidence.title")} close={close}>
        <ReadFailure read={evidence} section={t("findings.evidence.title")} />
      </EvidenceDialog>
    );
  }
  const value = evidence.value;
  const { finding } = value;
  return (
    <EvidenceDialog
      title={t("findings.evidence.title")}
      subtitle={`${t(`findings.kind.${finding.kind}`)} ${finding.subject}`}
      close={close}
    >
      <div className="flex flex-col gap-3.5">
        <TileStrip>
          <Tile
            term={t("findings.evidence.atStake")}
            note={t("findings.evidence.atStakeNote")}
          >
            <MoneyFigure money={finding.saving} />
            <EstimateBasis cost={finding.saving} />
          </Tile>
          <Tile
            term={t("findings.evidence.covered")}
            note={t("findings.evidence.coveredNote")}
          >
            {t("findings.evidence.coveredValue", {
              covered: formatCount(value.coveredCalls, locale),
              calls: formatCount(value.calls, locale),
            })}
          </Tile>
        </TileStrip>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
          <dt className="text-muted-foreground">
            {t("findings.evidence.confidence")}
          </dt>
          <dd>{t(`findings.confidence.${finding.confidence}`)}</dd>
          <dt className="text-muted-foreground">
            {t("findings.evidence.tokens")}
          </dt>
          <dd>
            {t("findings.evidence.tokensValue", {
              measured: formatCount(value.measuredTokens, locale),
              counterfactual: formatCount(value.counterfactualTokens, locale),
            })}
          </dd>
          <dt className="text-muted-foreground">
            {t("findings.evidence.measured")}
          </dt>
          <dd>
            <Money value={value.measured} precision="exact" />
          </dd>
          <dt className="text-muted-foreground">
            {t("findings.evidence.counterfactual")}
          </dt>
          <dd>
            <Money value={value.counterfactual} precision="exact" />
          </dd>
          <dt className="text-muted-foreground">
            {t("findings.evidence.window")}
          </dt>
          <dd>
            <Instant iso={finding.window.from} /> {t("findings.evidence.to")}{" "}
            <Instant iso={finding.window.to} />
          </dd>
        </dl>
        <Panel
          id="spend-finding-runs"
          title={t("findings.evidence.runs")}
          footer={t("findings.evidence.note")}
        >
          {value.runs.length === 0 ? (
            <Empty>{t("findings.evidence.runsEmpty")}</Empty>
          ) : (
            <Table
              label={t("findings.evidence.runs")}
              columns={[
                { label: t("findings.evidence.columns.run") },
                { label: t("findings.evidence.columns.startedAt") },
                { label: t("columns.calls"), numeric: true },
                {
                  label: t("findings.evidence.columns.measured"),
                  numeric: true,
                },
                {
                  label: t("findings.evidence.columns.counterfactual"),
                  numeric: true,
                },
              ]}
            >
              {value.runs.map((run) => (
                <tr key={run.runId} data-key={run.runId}>
                  <th scope="row" className={`${cell} text-left font-normal`}>
                    <SafeLink
                      to={routes.run(at.org, at.ws, run.runId)}
                      className={`${linkText} ${mono}`}
                    >
                      {run.runId}
                    </SafeLink>
                  </th>
                  <td className={cell}>
                    <Instant iso={run.startedAt} />
                  </td>
                  <td className={numericCell}>
                    {formatCount(run.calls, locale)}
                  </td>
                  <td className={numericCell}>
                    <Money value={run.measured} precision="exact" />
                  </td>
                  <td className={numericCell}>
                    <Money value={run.counterfactual} precision="exact" />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
        <BasisLabel basis={finding.saving.basis} />
      </div>
    </EvidenceDialog>
  );
}
