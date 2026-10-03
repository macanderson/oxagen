// Cost and History (roadmap mockups/src/work.js `costPanel()`,
// `historyPanel()`).
//
// Cost lists what each run the item's sends started cost. A run that reported
// no usage reads unknown and never $0.00, and the total says how many runs it
// covers. In-app triage spend is the organization's, so it shows on Billing.
//
// History is every fact the item holds, in time order, one sentence each.
// It is append-only: a return or a reopen adds facts and erases none, so the
// earlier pull request, acceptance and close stay here.
import { useTranslations } from "next-intl";
import type { WorkHistoryEntry, WorkItemDetail } from "@/data/contracts/work";
import { routes } from "@/shared/safe-path";
import {
  linkText,
  panel,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { Money } from "@/ui/money";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { shortSha } from "../words";
import { useWhen } from "./phrases";
import { isHistoryKind } from "./view";

type At = { org: string; ws: string };

const TIERS = ["contained", "gateway", "harness", "observe"] as const;
type Tier = (typeof TIERS)[number];
const isTier = (tier: string | null): tier is Tier =>
  TIERS.some((known) => known === tier);

export function CostPanel({ detail, at }: { detail: WorkItemDetail; at: At }) {
  const t = useTranslations("workItem.cost");
  const coverage = detail.item.cost;
  // Oldest send first, so the rows read in the order the runs happened.
  const rows = [...detail.sends]
    .reverse()
    .flatMap((send) => send.runs.map((run) => ({ send, run })));
  return (
    <section aria-labelledby="work-cost-heading" data-testid="work-panel-cost" className={panel}>
      <div className={panelHeader}>
        <h2 id="work-cost-heading" className={panelTitle}>
          {t("heading")}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t.rich("triageSpend", {
            link: (chunks) => (
              <SafeLink to={routes.billing(at.org)} className={linkText}>
                {chunks}
              </SafeLink>
            ),
          })}
        </span>
      </div>
      <Table
        label={t("tableLabel")}
        columns={[
          { label: t("columns.run") },
          { label: t("columns.tier") },
          { label: t("columns.cost"), numeric: true },
        ]}
      >
        {rows.map(({ send, run }) => {
          const tier = run.tier ?? send.runtime.tier;
          return (
            <tr key={run.id} data-testid={`work-cost-${run.id}`}>
              <td className={cell}>
                <span className="text-foreground">{t("sendNumber", { send: String(send.send) })}</span>
                <SafeLink
                  to={routes.run(at.org, at.ws, run.id)}
                  className={`${linkText} block text-sm`}
                >
                  {t("openRun")}
                </SafeLink>
              </td>
              <td className={cell}>
                {isTier(tier) ? (
                  <EnforcementTierBadge tier={tier} />
                ) : (
                  <span className="text-muted-foreground">{tier}</span>
                )}
              </td>
              <td className={numericCell}>
                {run.cost === null ? (
                  <span className="flex flex-col items-end font-sans">
                    <span className="text-muted-foreground">{t("unknown")}</span>
                    <span className="text-sm text-muted-foreground">{t("noUsage")}</span>
                  </span>
                ) : (
                  <Money value={run.cost} />
                )}
              </td>
            </tr>
          );
        })}
        <tr data-testid="work-cost-total" className="border-t border-border">
          <td className={cell}>
            <span className="font-semibold text-foreground">{t("recorded")}</span>
            <span className="block text-sm text-muted-foreground">
              {t("coverage", { known: coverage.knownRuns, runs: coverage.runs })}
            </span>
          </td>
          <td className={cell} />
          <td className={`${numericCell} font-semibold`}>
            {coverage.total === null ? (
              <span className="font-sans text-muted-foreground">{t("unknown")}</span>
            ) : (
              <Money value={coverage.total} />
            )}
          </td>
        </tr>
      </Table>
    </section>
  );
}

function HistoryLine({ entry }: { entry: WorkHistoryEntry }) {
  const t = useTranslations("workItem.history");
  const source = (): string => {
    switch (entry.source) {
      case "provider":
        return t("sources.provider");
      case "runtime":
        return t("sources.runtime");
      case "agent":
        return t("sources.agent");
      case "person":
        return t("sources.person");
      case "oxagen":
        return t("sources.oxagen");
    }
  };
  const values = {
    actor: entry.actor ?? source(),
    send: entry.send === null ? "" : String(entry.send),
    reason: entry.reason ?? "",
    resolution: entry.resolution ?? "",
    outcome: entry.outcome ?? "",
    head: entry.head === null ? "" : shortSha(entry.head),
    check: entry.check ?? "",
    conclusion: entry.conclusion ?? "",
    pullRequest: entry.pullRequest ?? "",
    mergeCommit: entry.mergeCommit === null ? "" : shortSha(entry.mergeCommit),
    brief: entry.briefRevision === null ? "" : String(entry.briefRevision),
    revision: String(entry.itemRevision),
  };
  const text = isHistoryKind(entry.kind)
    ? t(`kinds.${entry.kind}`, values)
    : t("unknown", { kind: entry.kind });
  // A missing fact (no reason, say) leaves a trailing space, not a gap.
  return <>{text.trim()}</>;
}

export function HistoryPanel({ detail }: { detail: WorkItemDetail }) {
  const t = useTranslations("workItem.history");
  const when = useWhen();
  // Time order, oldest first. Entries at the same instant keep the record's order.
  const entries = detail.history
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.at === b.entry.at
        ? a.index - b.index
        : Date.parse(a.entry.at) - Date.parse(b.entry.at),
    );
  return (
    <section
      aria-labelledby="work-history-heading"
      data-testid="work-panel-history"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-history-heading" className={panelTitle}>
          {t("heading")}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t("count", { count: entries.length })}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ol className="divide-y divide-border">
          {entries.map(({ entry, index }) => (
            <li
              key={`${entry.at}-${String(index)}`}
              data-testid="work-history-entry"
              data-kind={entry.kind}
              className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:gap-4"
            >
              <time dateTime={entry.at} className="shrink-0 text-sm text-muted-foreground sm:w-36">
                {when(entry.at)}
              </time>
              <span className="min-w-0 text-foreground wrap-anywhere">
                <HistoryLine entry={entry} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
