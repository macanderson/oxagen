// The stat strip: exactly two tiles, Live runs and Waiting on a human, each
// counted from a read the page already renders. A tile whose read failed is not
// drawn; its section below shows the failure.
import { useLocale, useTranslations } from "next-intl";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
import type { RunPage } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { formatClock, formatCount } from "@/ui/money-format";
import { Clock } from "./clock";

const TILE =
  "flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-4";

function LiveRuns({ page }: { page: RunPage }) {
  const t = useTranslations("fleet.stats.live");
  const locale = useLocale();
  const live = page.runs.filter((run) => run.status === "live").length;
  const agents = new Set(
    page.runs.flatMap((run) => (run.agentKey === null ? [] : [run.agentKey])),
  ).size;
  return (
    <dl data-testid="tile" className={TILE}>
      <dt className="text-xs font-medium text-muted-foreground">
        {t("title")}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums">
        {formatCount(live, locale)}
      </dd>
      <dd className="text-xs text-muted-foreground">
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
    <dl data-testid="tile" className={TILE}>
      <dt className="text-xs font-medium text-muted-foreground">
        {t("title")}
      </dt>
      <dd className="text-2xl font-semibold tabular-nums">
        {queue.more ? t("more", { count }) : count}
      </dd>
      {queue.more ? (
        <dd
          data-testid="waiting-more"
          className="text-xs text-muted-foreground"
        >
          {t("moreBasis")}
        </dd>
      ) : null}
      <dd className="text-xs text-muted-foreground">
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
}: {
  runs: Read<RunPage>;
  approvals: Read<ApprovalQueue>;
  now: number;
}) {
  const t = useTranslations("fleet.stats");
  if (!runs.ok && !approvals.ok) return null;
  return (
    <section aria-label={t("label")} className="grid gap-3 sm:grid-cols-2">
      {runs.ok ? <LiveRuns page={runs.value} /> : null}
      {approvals.ok ? <Waiting queue={approvals.value} now={now} /> : null}
    </section>
  );
}
