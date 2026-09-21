import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
import { sumMoney, type Money as MoneyValue } from "@/data/contracts/money";
import type { RunPage } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { statNote, statStrip, statTerm, statTile, statValue } from "@/ui/control-styles";
import { formatClock, formatCount } from "@/ui/money-format";
import { Money } from "@/ui/money";
import { Clock } from "./clock";

function LiveRuns({ page }: { page: RunPage }) {
  const t = useTranslations("fleet.stats.live");
  const locale = useLocale();
  const live = page.runs.filter((run) => run.status === "live").length;
  const agents = new Set(
    page.runs.flatMap((run) => (run.agentKey === null ? [] : [run.agentKey])),
  ).size;
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>
        {t("title")}
      </dt>
      <dd className={statValue}>
        {formatCount(live, locale)}
      </dd>
      <dd className={statNote}>
        {t("basis", { agents, count: formatCount(agents, locale) })}
      </dd>
    </dl>
  );
}

/**
 * How many calls are parked, and how long the oldest has waited.
 *
 * The figure is the whole queue, not one page of it. `approvals.pending` walks
 * the cursor to the end under a bound and sets `more` when the bound stopped
 * it, so a count this tile cannot stand behind reads `1,000+` rather than an
 * exact number that is wrong. The line under it then says a bound stopped the
 * read, because "1,000+" with no explanation is a figure nobody can act on.
 */
function Waiting({ queue, now }: { queue: ApprovalQueue; now: number }) {
  const t = useTranslations("fleet.stats.waiting");
  const locale = useLocale();
  const { items } = queue;
  const oldest = items.reduce<ApprovalItem | null>(
    (first, item) =>
      first === null || Date.parse(item.createdAt) < Date.parse(first.createdAt)
        ? item
        : first,
    null,
  );
  const count = formatCount(items.length, locale);
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>
        {t("title")}
      </dt>
      <dd
        className={`${statValue} ${items.length > 0 ? "text-info" : ""}`}
      >
        {queue.more ? t("more", { count }) : count}
      </dd>
      {queue.more ? (
        <dd
          data-testid="waiting-more"
          className={statNote}
        >
          {t("moreBasis")}
        </dd>
      ) : null}
      <dd className={statNote}>
        {oldest === null
          ? t("none")
          : t.rich("oldest", {
              clock: () => (
                <Clock
                  at={Date.parse(oldest.createdAt)}
                  now={now}
                  direction="since"
                />
              ),
              window: formatClock(
                (Date.parse(oldest.expiresAt) - Date.parse(oldest.createdAt)) /
                  1000,
                locale,
              ),
            })}
      </dd>
    </dl>
  );
}

function SpendShown({ page }: { page: RunPage }) {
  const t = useTranslations("fleet.stats.spend");
  const totals = new Map<string, MoneyValue[]>();
  let priced = 0;
  for (const run of page.runs) {
    if (run.cost === null) continue;
    priced += 1;
    totals.set(run.cost.currency, [
      ...(totals.get(run.cost.currency) ?? []),
      run.cost,
    ]);
  }
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>
        {t("title")}
      </dt>
      <dd className={`flex flex-wrap gap-x-3 ${statValue}`}>
        {totals.size === 0 ? (
          <span>{t("unavailable")}</span>
        ) : (
          [...totals].map(([currency, costs]) => {
            const total = sumMoney(costs);
            return total === null ? null : (
              <Money key={currency} value={total} />
            );
          })
        )}
      </dd>
      <dd className={statNote}>
        {t("coverage", { priced, count: page.runs.length })}
      </dd>
    </dl>
  );
}

export function StatStrip({
  runs,
  approvals,
  now,
  spendTiles,
}: {
  spendTiles?: ReactNode;
  runs: Read<RunPage>;
  approvals: Read<ApprovalQueue>;
  now: number;
}) {
  const t = useTranslations("fleet.stats");
  if (!runs.ok && !approvals.ok && spendTiles === undefined) return null;
  return (
    <section
      aria-label={t("label")}
      className={statStrip}
    >
      {runs.ok ? <LiveRuns page={runs.value} /> : null}
      {approvals.ok ? <Waiting queue={approvals.value} now={now} /> : null}
      {spendTiles === undefined ? (
        runs.ok ? (
          <SpendShown page={runs.value} />
        ) : null
      ) : (
        spendTiles
      )}
    </section>
  );
}
