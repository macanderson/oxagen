// Proposals: what is proposed but not published (roadmap pages/steering.md;
// the tab body is pages/steering-proposals.md, which the steering-tabs lane
// builds). Its two segments are the candidates and their Context PRs, each an
// address: `/steering/proposals` and `/steering/proposals/prs`.
import { useTranslations } from "next-intl";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ContextPrs } from "../context-prs";
import { Proposals } from "../proposals";
import { type ProposalSegment, type SteeringAt, steeringLink } from "../view";

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
      <SafeLink
        role="button"
        to={steeringLink(at, { tab: "proposals" })}
        aria-pressed={current === "candidates"}
        className={chip}
      >
        {t("candidates")}
      </SafeLink>
      <SafeLink
        role="button"
        to={steeringLink(at, { tab: "prs" })}
        aria-pressed={current === "prs"}
        className={chip}
      >
        {t("prs")}
      </SafeLink>
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
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  segment: ProposalSegment;
  offset: number;
  proposal: string | null;
}) {
  const [read, pr] = await Promise.all([
    source.steering.proposals(ctx, { offset }),
    segment === "prs" && proposal !== null
      ? source.steering.contextPr(ctx, proposal)
      : null,
  ]);
  return (
    <div className="flex flex-col gap-4" data-testid="tab-proposals">
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
