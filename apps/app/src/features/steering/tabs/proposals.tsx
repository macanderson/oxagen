// Proposals: what is proposed but not published (roadmap pages/steering.md).
// One list at `/steering/proposals`, filtered by state the way a pull request
// list is (#5077): Open (a candidate with no pull request yet, or a steering
// PR still open), Merged and Closed, each with its count. The state is the
// `?state=` query value, so a reload or a shared link keeps it, and Open is
// the default. Each row opens that proposal's steering PR page.
import { useTranslations } from "next-intl";
import {
  PROPOSAL_STATES,
  type ProposalState,
} from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { buttonSecondary } from "@/ui/control-styles";
import { LiveRefresh } from "@/ui/live-refresh";
import { PressLink } from "@/ui/press-link";
import { ProposalList } from "../proposal-list";
import { type SteeringAt, steeringLink } from "../view";

/** A proposal whose steering PR is open on the repository host. */
const OPEN_PR_STATUSES: ReadonlySet<string> = new Set([
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
]);

/** The count beside each state filter. */
export type ProposalStateCounts = Record<ProposalState, number>;

const chip = `${buttonSecondary} min-h-7 gap-1.5 px-2.5 py-1 text-[12.5px] aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`;

function StateFilters({
  at,
  rows,
  current,
  counts,
}: {
  at: SteeringAt;
  /** The page size, which every filter keeps. */
  rows: number;
  current: ProposalState;
  /** Null when a count failed: each filter then prints no number. */
  counts: ProposalStateCounts | null;
}) {
  const t = useTranslations("steering.proposals.states");
  return (
    <div
      role="group"
      aria-label={t("label")}
      className="flex flex-wrap gap-1.5"
      data-testid="proposal-states"
    >
      {PROPOSAL_STATES.map((state) => (
        <PressLink
          key={state}
          to={steeringLink(at, { tab: "proposals", state, rows })}
          pressed={state === current}
          data-state-filter={state}
          className={chip}
        >
          {t(state)}
          {counts === null ? null : (
            <span
              className="font-mono text-[11px] text-dim"
              data-count={String(counts[state])}
            >
              {counts[state]}
            </span>
          )}
        </PressLink>
      ))}
    </div>
  );
}

export async function ProposalsTab({
  ctx,
  source,
  at,
  state,
  offset,
  rows,
  counts,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  state: ProposalState;
  offset: number;
  /** How many proposals a page holds, one of PROPOSAL_ROWS (#4693). */
  rows: number;
  /** The three filter counts from the hub's read; null when one failed. */
  counts: ProposalStateCounts | null;
}) {
  const read = await source.steering.proposals(ctx, {
    offset,
    limit: rows,
    state,
  });
  // A steering PR can merge or close on the repository host at any moment, and
  // the repository sync moves the proposal within seconds (ADR-184). While
  // one is open, the page re-reads itself so the change shows up here.
  const waiting =
    read.ok && read.value.proposals.some((p) => OPEN_PR_STATUSES.has(p.status));
  return (
    <div className="flex flex-col gap-4" data-testid="tab-proposals">
      <LiveRefresh active={waiting} intervalMs={10_000} />
      <StateFilters at={at} rows={rows} current={state} counts={counts} />
      <ProposalList
        at={at}
        state={state}
        offset={offset}
        rows={rows}
        read={read}
      />
    </div>
  );
}
