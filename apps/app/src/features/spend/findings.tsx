// Spend › Findings (#2963, ADR-062): the workspace's open findings ranked by
// the money at stake, each with what it cites, why it costs money and the fix,
// and one finding's evidence — the cited runs, the calls the counterfactual
// covers and what each side cost. Every figure is the findings job's. The one
// thing computed here is a finding's share of the listed total, divided
// through the micros seam and printed as a ratio (INV-09, INV-10).
import { useLocale, useTranslations } from "next-intl";
import { ratioOfMicros } from "@/data/contracts/money";
import type {
  SpendFinding,
  SpendFindingEvidence,
  SpendFindings,
} from "@/data/contracts/spend";
import { routes } from "@/shared/safe-path";
import {
  eyebrow,
  linkText,
  mono,
  panel,
  panelHeader,
  panelFooter,
} from "@/ui/control-styles";
import { formatCount, formatMoney, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import {
  CostFigure,
  EstimateBasis,
  CountFigure,
  Instant,
  MoneyFigure,
  NotRecordedValue,
  RatioFigure,
  Tile,
  TileStrip,
} from "./figures";
import { FixDialog } from "./fix-dialog";
import { Empty, HeaderCell, Panel } from "./tables";
import type { SpendAt } from "./view";

/** Findings named in the legend; the rest roll into one entry, since at forty a name per slice is unreadable. */
const LEGEND_MAX = 8;

/** The strip's shading, darkest for the largest saving. */
const RAMP = [1, 0.8, 0.64, 0.5, 0.38, 0.28];

const cell = "px-4 py-2 text-left align-top";

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
            className="block h-full bg-foreground"
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
              className="size-2 rounded-sm bg-foreground"
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
            className="size-2 rounded-sm bg-foreground opacity-20"
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

function FindingCard({
  finding,
  rank,
  share,
  at,
}: {
  finding: SpendFinding;
  rank: number;
  share: number | null;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <li
      data-finding={finding.id}
      data-confidence={finding.confidence}
      className={`${panel} grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_240px]`}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`${mono} text-xs text-muted-foreground`}>
            {t("findings.rank", { rank: formatCount(rank, locale) })}
          </span>
          <h3 className="text-base font-semibold">
            {t(`findings.kind.${finding.kind}`)}
          </h3>
          <span
            data-level={finding.level}
            className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
          >
            {t(`findings.level.${finding.level}`)}
          </span>
          <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
            {t(`findings.confidence.${finding.confidence}`)}
          </span>
        </div>
        <p className={`${mono} break-words text-sm`}>{finding.subject}</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {t("findings.why")}
          </span>{" "}
          {finding.why}
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {t("findings.fixLabel")}
          </span>{" "}
          {finding.fix}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("findings.cites", {
            runs: formatCount(finding.runs, locale),
            calls: formatCount(finding.calls, locale),
          })}
          {" · "}
          <Instant iso={finding.window.from} />
          {" · "}
          <Instant iso={finding.window.to} />
        </p>
      </div>
      <div className="flex flex-none flex-col items-start gap-2 rounded-lg bg-data-surface p-3 sm:items-end">
        <span className="text-xs text-muted-foreground">
          {t("findings.saving")}
        </span>
        <span className="font-mono text-2xl font-semibold tabular-nums">
          <MoneyFigure money={finding.saving} />
          <EstimateBasis cost={finding.saving} />
        </span>
        <span className="text-xs text-muted-foreground">
          {share === null
            ? t("findings.shareUnknown")
            : t("findings.shareOfIdentified", {
                share: formatRatio(share, locale),
              })}
        </span>
        <div className="flex flex-wrap gap-2">
          <SafeLink
            to={routes.spend(at.org, at.ws, {
              tab: "findings",
              finding: finding.id,
            })}
            className={linkText}
          >
            {t("findings.evidence.open")}
          </SafeLink>
          <FixDialog
            at={at}
            findingId={finding.id}
            fix={finding.fix}
            contextDescription={t("findings.fix.draft", {
              id: finding.id,
              subject: finding.subject,
              from: finding.window.from,
              to: finding.window.to,
              amount: formatMoney(finding.saving, {
                locale,
                precision: "exact",
              }),
              currency: finding.saving.currency,
              basis:
                finding.saving.basis === null
                  ? t("basisNotRecorded")
                  : t(`basis.${finding.saving.basis}`),
              runs: formatCount(finding.runs, locale),
              calls: formatCount(finding.calls, locale),
              fix: finding.fix,
              why: finding.why,
            })}
          />
        </div>
      </div>
    </li>
  );
}

export function FindingsSection({
  findings,
  at,
}: {
  findings: SpendFindings;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const shares = sharesOf(findings.findings, findings.saving);
  return (
    <>
      <section
        aria-labelledby="spend-findings-hero"
        className={`${panel} flex flex-col overflow-hidden`}
      >
        <div className={panelHeader}>
          <p className={eyebrow}>{t("findings.eyebrow")}</p>
          <h2 id="spend-findings-hero" className="sr-only">
            {t("findings.heroTitle")}
          </h2>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <dl className="grid gap-6 rounded-lg bg-data-surface p-4 lg:grid-cols-[minmax(240px,1.3fr)_repeat(3,minmax(0,1fr))]">
            <div className="flex flex-col gap-2">
              <dt className="text-sm text-muted-foreground">
                {t("findings.saving")}
              </dt>
              <dd className="font-mono text-4xl font-semibold tracking-tight tabular-nums">
                <MoneyFigure money={findings.saving} />
                <EstimateBasis cost={findings.saving} />
              </dd>
              <dd className="text-xs text-muted-foreground">
                {t("findings.savingNote")}
              </dd>
            </div>
            <div className="flex flex-col gap-2">
              <dt className="text-xs text-muted-foreground">
                {t("findings.share")}
              </dt>
              <dd className="font-mono text-xl tabular-nums">
                <RatioFigure ratio={findings.share} />
              </dd>
              <dd className="text-xs text-muted-foreground">
                {t("findings.shareNote")}
              </dd>
            </div>
            <div className="flex flex-col gap-2">
              <dt className="text-xs text-muted-foreground">
                {t("findings.annualised")}
              </dt>
              <dd className="font-mono text-xl tabular-nums">
                <MoneyFigure money={findings.annualised} />
                <EstimateBasis cost={findings.annualised} />
              </dd>
              <dd className="text-xs text-muted-foreground">
                {t("findings.annualisedNote")}
              </dd>
            </div>
            <div className="flex flex-col gap-2">
              <dt className="text-xs text-muted-foreground">
                {t("findings.spend")}
              </dt>
              <dd className="font-mono text-xl tabular-nums">
                <CostFigure cost={findings.spend} />
              </dd>
              <dd className="text-xs text-muted-foreground">
                {t("findings.spendNote")}
              </dd>
            </div>
          </dl>
          {findings.findings.length === 0 ? null : (
            <>
              <CompositionStrip findings={findings.findings} shares={shares} />
              <Legend findings={findings.findings} shares={shares} />
            </>
          )}
          <p className="text-sm text-muted-foreground">
            {t("findings.facts", {
              findings: formatCount(findings.counts.findings, locale),
              operators: formatCount(findings.counts.operators, locale),
              high: formatCount(findings.counts.high, locale),
              medium: formatCount(findings.counts.medium, locale),
            })}
          </p>
        </div>
        <p className={panelFooter}>{t("findings.note")}</p>
      </section>
      {findings.findings.length === 0 ? (
        <section
          data-state="empty"
          className={`${panel} flex flex-col gap-2 p-6`}
        >
          <h2 className="text-base font-semibold">
            {t("findings.emptyTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("findings.empty")}</p>
        </section>
      ) : (
        <ol aria-label={t("findings.list")} className="flex flex-col gap-3">
          {findings.findings.map((finding, index) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              rank={index + 1}
              share={shares[index] ?? null}
              at={at}
            />
          ))}
        </ol>
      )}
    </>
  );
}

export function FindingEvidenceSection({
  evidence,
  at,
}: {
  evidence: SpendFindingEvidence;
  at: SpendAt;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  const { finding } = evidence;
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className={eyebrow}>{t("findings.evidence.eyebrow")}</p>
        <h2 className="text-lg font-semibold">
          {t(`findings.kind.${finding.kind}`)}{" "}
          <span className={mono}>{finding.subject}</span>
        </h2>
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: "findings" })}
          className={`${linkText} text-sm`}
        >
          {t("findings.evidence.back")}
        </SafeLink>
      </div>
      <TileStrip>
        <Tile
          term={t("findings.evidence.atStake")}
          note={t("findings.evidence.atStakeNote")}
        >
          <MoneyFigure money={finding.saving} />
          <EstimateBasis cost={finding.saving} />
        </Tile>
        <Tile term={t("findings.evidence.confidence")}>
          {t(`findings.confidence.${finding.confidence}`)}
        </Tile>
        <Tile
          term={t("findings.evidence.covered")}
          note={t("findings.evidence.coveredNote")}
        >
          {t("findings.evidence.coveredValue", {
            covered: formatCount(evidence.coveredCalls, locale),
            calls: formatCount(evidence.calls, locale),
          })}
        </Tile>
        <Tile
          term={t("findings.evidence.tokens")}
          note={t("findings.evidence.tokensNote")}
        >
          {t("findings.evidence.tokensValue", {
            measured: formatCount(evidence.measuredTokens, locale),
            counterfactual: formatCount(evidence.counterfactualTokens, locale),
          })}
        </Tile>
      </TileStrip>
      <TileStrip>
        <Tile term={t("findings.evidence.measured")}>
          <MoneyFigure money={evidence.measured} />
        </Tile>
        <Tile term={t("findings.evidence.counterfactual")}>
          <MoneyFigure money={evidence.counterfactual} />
        </Tile>
      </TileStrip>
      <Panel
        id="spend-finding-runs"
        title={t("findings.evidence.runs")}
        footer={t("findings.evidence.note")}
      >
        {evidence.runs.length === 0 ? (
          <Empty>{t("findings.evidence.runsEmpty")}</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <HeaderCell>{t("findings.evidence.columns.run")}</HeaderCell>
                <HeaderCell>
                  {t("findings.evidence.columns.startedAt")}
                </HeaderCell>
                <HeaderCell>{t("columns.calls")}</HeaderCell>
                <HeaderCell>
                  {t("findings.evidence.columns.measured")}
                </HeaderCell>
                <HeaderCell>
                  {t("findings.evidence.columns.counterfactual")}
                </HeaderCell>
              </tr>
            </thead>
            <tbody>
              {evidence.runs.map((run) => (
                <tr key={run.runId} data-key={run.runId}>
                  <th scope="row" className={`${cell} font-normal`}>
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
                  <td className={cell}>
                    <CountFigure count={run.calls} />
                  </td>
                  <td className={cell}>
                    <MoneyFigure money={run.measured} />
                  </td>
                  <td className={cell}>
                    <MoneyFigure money={run.counterfactual} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
