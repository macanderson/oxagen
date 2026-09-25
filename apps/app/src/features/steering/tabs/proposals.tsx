// Proposals: what is proposed but not published (roadmap pages/steering.md;
// the tab body is pages/steering-proposals.md, which the steering-tabs lane
// builds). Its two segments are the candidates and their Context PRs, each an
// address: `/steering/proposals` and `/steering/proposals/prs`.
import { useTranslations } from "next-intl";
import type { ContextPr } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { buttonSecondary } from "@/ui/control-styles";
import { LiveRefresh } from "@/ui/live-refresh";
import { PressLink } from "@/ui/press-link";
import { ContextPrs } from "../context-prs";
import { Proposals } from "../proposals";
import { type ProposalSegment, type SteeringAt, steeringLink } from "../view";

/** A proposal whose Context PR is open on the repository host. */
const OPEN_PR_STATUSES: ReadonlySet<string> = new Set([
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
]);

const chip = `${buttonSecondary} min-h-7 px-2.5 py-1 text-[12.5px] aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`;

function Segments({
  at,
  current,
}: {
  at: SteeringAt;
  current: ProposalSegment;
}) {
  const t = useTranslations("steering.tabs");
  return (
    <div
      role="group"
      aria-label={t("segments")}
      className="flex flex-wrap gap-1.5"
      data-testid="proposal-segments"
    >
      <PressLink
        to={steeringLink(at, { tab: "proposals" })}
        pressed={current === "candidates"}
        className={chip}
      >
        {t("candidates")}
      </PressLink>
      <PressLink
        to={steeringLink(at, { tab: "prs" })}
        pressed={current === "prs"}
        className={chip}
      >
        {t("prs")}
      </PressLink>
    </div>
  );
}

export async function ProposalsTab({
  ctx,
  source,
  at,
  segment,
  offset,
  proposal,
  pr: preread,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  segment: ProposalSegment;
  offset: number;
  proposal: string | null;
  /**
   * get_context_pr for `proposal`, when the hub already read it to decide
   * which action is gold; read here otherwise.
   */
  pr?: Read<ContextPr> | null;
}) {
  const [read, pr] = await Promise.all([
    source.steering.proposals(ctx, { offset }),
    segment === "prs" && proposal !== null
      ? (preread ?? source.steering.contextPr(ctx, proposal))
      : null,
  ]);
  // A Context PR can merge or close on the repository host at any moment, and
  // the repository sync moves the proposal within seconds (ADR-182). While
  // one is open, the page re-reads itself so the change shows up here.
  const waiting =
    read.ok && read.value.proposals.some((p) => OPEN_PR_STATUSES.has(p.status));
  return (
    <div className="flex flex-col gap-4" data-testid="tab-proposals">
      <LiveRefresh active={waiting} intervalMs={10_000} />
      <Segments at={at} current={segment} />
      {segment === "prs" ? (
        <ContextPrs
          at={at}
          offset={offset}
          read={read}
          selected={proposal}
          pr={pr}
        />
      ) : (
        <Proposals at={at} offset={offset} read={read} />
      )}
    </div>
  );
}
