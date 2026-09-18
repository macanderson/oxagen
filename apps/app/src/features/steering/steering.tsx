// Steering (#2961; ARCHITECTURE.md §1.2): the records in force in this
// workspace, the proposals waiting for a person with the support they cite,
// and the Context PR that publishes one: its state machine, its checks, what
// merge will do and the merge. Effect metrics, retirement candidates and
// promotion thresholds are not in this release. Each tab makes only the reads
// it shows.
import type { DataSource } from "@/data/ports";
import { PageRecord } from "@/features/shell";
import type { WsCtx } from "@/server/viewer";
import { ContextPrs } from "./context-prs";
import { Proposals } from "./proposals";
import { Records } from "./records";
import { SteeringTabs } from "./tabs";
import { parseSteeringView, type SteeringAt, type SteeringView } from "./view";

async function TabBody({
  ctx,
  source,
  view,
  at,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  at: SteeringAt;
}) {
  switch (view.tab) {
    case "records": {
      const read = await source.steering.records(ctx, {
        kind: view.kind,
        offset: view.offset,
      });
      return (
        <Records at={at} kind={view.kind} offset={view.offset} read={read} />
      );
    }
    case "proposals": {
      const read = await source.steering.proposals(ctx, {
        offset: view.offset,
      });
      return <Proposals at={at} offset={view.offset} read={read} />;
    }
    case "prs": {
      const { proposal } = view;
      const [read, pr] = await Promise.all([
        source.steering.proposals(ctx, { offset: view.offset }),
        proposal === null ? null : source.steering.contextPr(ctx, proposal),
      ]);
      return (
        <ContextPrs
          at={at}
          offset={view.offset}
          read={read}
          selected={proposal}
          pr={pr}
        />
      );
    }
  }
}

export async function Steering({
  ctx,
  source,
  searchParams,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The query the URL carried: `tab`, `kind`, `offset`, `proposal`. */
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const view = parseSteeringView(searchParams);
  const at: SteeringAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  return (
    <div className="flex flex-col gap-6">
      {/* `proposal` selects nothing off the Context PRs tab, so the parse
          decides this, not the query string. */}
      <PageRecord route="steering" id={view.proposal} />
      <SteeringTabs at={at} current={view.tab} />
      {await TabBody({ ctx, source, view, at })}
    </div>
  );
}
