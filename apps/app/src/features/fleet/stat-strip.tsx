import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
import type { RunPage } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import {
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { formatClock, formatCount } from "@/ui/money-format";
import { ApprovalsEntry } from "./approvals-entry";
import { ReadFailure } from "@/ui/read-failure";
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
      <dt className={statTerm}>{t("title")}</dt>
      <dd className={statValue}>{formatCount(live, locale)}</dd>
      <dd className={statNote}>
        {t("basis", { agents, count: formatCount(agents, locale) })}
      </dd>
    </dl>
  );
}

/**
 * How many calls are parked, and how long the oldest has waited.
 *
 * The figure is the whole queue's count, which `list_approvals` answers beside
 * its first page (#3521), not the length of the page. The oldest wait is read
 * from that page, which holds the calls that time out soonest. When the queue
 * is longer than the page, a line says so, because a call parked earlier with
 * a longer window can sit past the page.
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
  return (
    <dl data-testid="tile" className={statTile}>
      <dt className={statTerm}>{t("title")}</dt>
      <dd className={`${statValue} ${queue.total > 0 ? "text-info" : ""}`}>
        <ApprovalsEntry>{formatCount(queue.total, locale)}</ApprovalsEntry>
      </dd>
      {queue.more ? (
        <dd data-testid="waiting-more" className={statNote}>
          {t("pageBasis", { count: formatCount(items.length, locale) })}
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

export function StatStrip({
  runs,
  approvals,
  now,
  spendTiles,
}: {
  /** The cost rollup's tiles (#2962), read by the page beside the runs. */
  spendTiles?: ReactNode;
  runs: Read<RunPage>;
  approvals: Read<ApprovalQueue>;
  now: number;
}) {
  const t = useTranslations("fleet.stats");
  return (
    <section aria-label={t("label")} className={statStrip}>
      {runs.ok ? <LiveRuns page={runs.value} /> : null}
      {approvals.ok ? (
        <Waiting queue={approvals.value} now={now} />
      ) : (
        <div className={statTile}>
          <ReadFailure read={approvals} section={t("waiting.title")} />
          <ApprovalsEntry />
        </div>
      )}
      {spendTiles}
    </section>
  );
}
