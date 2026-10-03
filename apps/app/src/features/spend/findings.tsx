// Spend › Findings (#2963, ADR-062; spec "Findings" and "Counting"): the
// workspace's open findings ranked by the money at stake, under a hero that
// leads with the period's unproductive spend. The hero prints the headline
// get_unproductive_spend answers (the same total the operator ranking's Total
// row prints) beside its share of the period's spend (counting rule 5). Beside
// them sit what detectors 2, 3, and 5 price and what detector 4 estimates,
// none of which adds to the headline (rules 2 and 3). The list filters, sorts
// and pages the findings; Evidence opens one finding's arithmetic in a dialog
// and Fix opens the change that removes it. Each card's share of the spend is
// divided through the micros seam and printed as a ratio (INV-09, INV-10).
// list_findings lists at most 50 findings a page, and a workspace can hold
// more, since the findings job never caps a finding the headline counts
// (#5262). The counts cover every open finding on every page. When the list
// is cut, a line above the cards says which findings the page shows of how
// many in all, and links under the cards open the next page or go back to
// the first (#5303). The cursor only reads forward, so the way back is the
// first page, as on an agent's incident list (#4693).
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  SpendFindingEvidence,
  SpendFindings,
  SpendReport,
  UnproductiveSpend,
} from "@/data/contracts/spend";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonSecondary,
  eyebrow,
  linkText,
  mono,
  panel,
} from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatRatio } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import type { AgentHarnesses } from "./agent-mark";
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

/** The handler's refusal for a period whose figures hold two currencies. */
const MIXED_CURRENCY = "unproductive_mixed_currency";

/**
 * The headline and its share of the period's spend, side by side (rule 5).
 * A read that did not answer says why in place of the figures.
 */
function Headline({ headline }: { headline: Read<UnproductiveSpend> }) {
  const t = useTranslations("spend.findings");
  const locale = useLocale();
  if (!headline.ok) {
    if (headline.reason === "error" && headline.code === MIXED_CURRENCY)
      return (
        <p className="text-sm text-muted-foreground">{t("mixedCurrency")}</p>
      );
    return <ReadFailure read={headline} section={t("hero")} />;
  }
  const { unproductive, spend, share } = headline.value;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span
          data-testid="spend-headline"
          className="text-4xl font-bold tracking-tight tabular-nums"
        >
          <Money value={unproductive} />
        </span>
        <span
          data-testid="spend-headline-share"
          className="text-2xl font-semibold tracking-tight tabular-nums"
        >
          {share === null ? <NotRecordedValue /> : formatRatio(share, locale)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {spend === null ? (
          t("heroNoSpend")
        ) : (
          <>
            {t("heroShareOf")} <Money value={spend} /> {t("heroPeriod")}
          </>
        )}
      </p>
    </>
  );
}

/** The catalog key that names each part detector. */
const PART_LABEL = {
  2: "detector.2",
  3: "detector.3",
  5: "detector.5",
} as const;

/**
 * What detectors 2, 3, and 5 price and what detector 4 estimates, each
 * beside the headline and none added to it (rules 2 and 3).
 */
function PartFigures({ headline }: { headline: Read<UnproductiveSpend> }) {
  const t = useTranslations("spend.findings.parts");
  if (!headline.ok) return null;
  const { parts, estimate } = headline.value;
  return (
    <div className="flex flex-col gap-2">
      <h3 className={eyebrow}>{t("title")}</h3>
      <dl
        data-testid="spend-headline-parts"
        className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] gap-x-4 gap-y-1.5 text-sm"
      >
        {parts.map((part) => (
          <div
            key={part.detector}
            data-detector={part.detector}
            className="contents"
          >
            <dt className="text-muted-foreground">
              {t(PART_LABEL[part.detector])}
            </dt>
            <dd className="text-right font-medium tabular-nums">
              <Money value={part.saving} />
            </dd>
            <dd className="text-right text-muted-foreground tabular-nums">
              {t("findings", { count: part.findings })}
            </dd>
          </div>
        ))}
        <div data-detector="4" className="contents">
          <dt className="text-muted-foreground">
            {t("estimate")}{" "}
            <span className="rounded-sm border border-border px-1 text-sm">
              {t("estimated")}
            </span>
          </dt>
          <dd className="text-right font-medium tabular-nums">
            <Money value={estimate.saving} />
          </dd>
          <dd className="text-right text-muted-foreground tabular-nums">
            {t("findings", { count: estimate.findings })}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{t("note")}</p>
    </div>
  );
}

/**
 * The links between pages of the list: the next page when one follows, and
 * the first page from any later one.
 */
function FindingsPages({
  at,
  cursor,
  next,
}: {
  at: SpendAt;
  cursor: string | null;
  next: string | null;
}) {
  const t = useTranslations("spend.findings.pages");
  if (cursor === null && next === null) return null;
  return (
    <nav
      aria-label={t("label")}
      data-testid="spend-findings-pages"
      className="flex flex-wrap gap-2"
    >
      {cursor === null ? null : (
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: "findings" })}
          className={buttonSecondary}
        >
          {t("first")}
        </SafeLink>
      )}
      {next === null ? null : (
        <SafeLink
          to={routes.spend(at.org, at.ws, { tab: "findings", cursor: next })}
          className={buttonSecondary}
        >
          {t("next")}
        </SafeLink>
      )}
    </nav>
  );
}

export function FindingsSection({
  headline,
  findings,
  cursor = null,
  operators,
  at,
  evidence,
  harnesses = {},
}: {
  /** The period's unproductive spend, the figure the hero leads with. */
  headline: Read<UnproductiveSpend>;
  findings: SpendFindings;
  /** The cursor of the page shown; null on the first page (#5303). */
  cursor?: string | null;
  /** The operator rollup, to name the person an operator finding is about. */
  operators: SpendReport["rows"];
  at: SpendAt;
  /** One finding's evidence, open as a dialog over the list; null when none is. */
  evidence: ReactNode;
  /** Each agent's registered harness, by key, for an agent finding's avatar. */
  harnesses?: AgentHarnesses;
}) {
  const t = useTranslations("spend.findings");
  const locale = useLocale();
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
          <Headline headline={headline} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <PartFigures headline={headline} />
          <ul className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-sm text-muted-foreground">
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
      {findings.findings.length === 0 && cursor !== null ? (
        // A cursor past the last finding: the findings after it were decided
        // since the page before was read.
        <section
          data-state="empty"
          className={`${panel} flex flex-col gap-3 p-6`}
        >
          <p className="text-sm text-muted-foreground">{t("pages.empty")}</p>
          <FindingsPages at={at} cursor={cursor} next={null} />
        </section>
      ) : findings.findings.length === 0 ? (
        <section
          data-state="empty"
          className={`${panel} flex flex-col gap-2 p-6`}
        >
          <h2 className="text-base font-semibold">{t("emptyTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </section>
      ) : (
        <>
          {findings.truncated ? (
            <p
              data-testid="spend-findings-truncated"
              className="text-sm text-muted-foreground"
            >
              {t("truncated", {
                from: formatCount(findings.offset + 1, locale),
                to: formatCount(
                  findings.offset + findings.findings.length,
                  locale,
                ),
                total: formatCount(findings.counts.findings, locale),
              })}
            </p>
          ) : null}
          {/* A new page remounts the list, so its filters and its own pager
              start over on the findings it now holds. */}
          <FindingsList
            key={findings.offset}
            findings={findings.findings}
            firstRank={findings.offset + 1}
            cursor={cursor}
            spend={findings.spend}
            names={names}
            harnesses={harnesses}
            at={at}
          />
          <FindingsPages at={at} cursor={cursor} next={findings.nextCursor} />
        </>
      )}
      <div className="flex flex-col gap-2 border-l-2 border-gold py-1 pl-3 text-sm text-muted-foreground">
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
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
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
                  <th
                    scope="row"
                    className={`${cell} min-w-48 text-left font-normal`}
                  >
                    <SafeLink
                      to={routes.run(at.org, at.ws, run.runId)}
                      title={run.name ?? undefined}
                      className={`${linkText} block truncate`}
                    >
                      {run.name ?? t("findings.evidence.untitled")}
                    </SafeLink>
                    <span
                      data-testid="run-id"
                      className={`${mono} block truncate text-sm text-dim`}
                    >
                      {run.runId}
                    </span>
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
