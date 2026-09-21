// Steering (#2961; ARCHITECTURE.md §1.2): the records in force in this
// workspace, the skills its harness sessions reported (the Skills tab, which
// is the Skills lane's inventory; MC spec §10.7), the proposals waiting for a
// person with the support they cite, and the Context PR that publishes one:
// its state machine, its checks, what merge will do and the merge. Effect metrics, retirement candidates and
// promotion thresholds are not in this release. Each tab makes only the reads
// it shows.
import { Suspense } from "react";
import { useTranslations } from "next-intl";
import { firstParam } from "@/shared/safe-path";
import type { Read } from "@/data/read";
import type { SteeringFreshness } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { PageRecord } from "@/features/shell";
import { Skills, SkillsLoading } from "@/features/skills";
import type { WsCtx } from "@/server/viewer";
import { ContextPrs } from "./context-prs";
import { Freshness } from "./freshness";
import { Proposals } from "./proposals";
import { ReadFailure } from "./read-failure";
import { Records } from "./records";
import { SteeringTabs } from "./tabs";
import { parseSteeringView, type SteeringAt, type SteeringView } from "./view";

function SettingsPanel({
  read,
  at,
  canEdit,
}: {
  read: Read<SteeringFreshness>;
  at: SteeringAt;
  canEdit: boolean;
}) {
  const t = useTranslations("steering.tabs");
  return read.ok ? (
    <Freshness at={at} read={read.value} canEdit={canEdit} />
  ) : (
    <ReadFailure read={read} section={t("settings")} />
  );
}

async function TabBody({
  ctx,
  source,
  view,
  skillView,
  at,
}: {
  ctx: WsCtx;
  source: DataSource;
  view: SteeringView;
  skillView: string | undefined;
  at: SteeringAt;
}) {
  switch (view.tab) {
    case "settings":
      return (
        <SettingsPanel
          read={await source.steering.freshness(ctx)}
          at={at}
          canEdit={canEditGates(ctx)}
        />
      );
    case "records": {
      const read = await source.steering.records(ctx, {
        kind: view.kind,
        offset: view.offset,
      });
      return (
        <Records at={at} kind={view.kind} offset={view.offset} read={read} />
      );
    }
    case "skills":
      return (
        <Suspense fallback={<SkillsLoading />}>
          <Skills
            ctx={ctx}
            source={source}
            cursor={view.cursor}
            view={skillView}
          />
        </Suspense>
      );
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
  /** The query the URL carried: `tab`, `kind`, `offset`, `proposal`, `cursor`. */
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
      {
        await TabBody({
          ctx,
          source,
          view,
          at,
          skillView: firstParam(searchParams.view),
        })
      }
    </div>
  );
}

/**
 * Who may set the gates, mirroring `update_workspace_settings`'s own gate
 * (INV-29): an org Owner or Admin, or the Owner or Admin of this workspace.
 *
 * The handler decides, not this; the check here only stops the page offering
 * a checkbox that would come back `denied`. Getting it wrong in the strict
 * direction hides a control from someone entitled to it, so it admits
 * exactly the roles the handler does and no fewer.
 */
function canEditGates(ctx: WsCtx): boolean {
  const admin = (role: string) => role === "owner" || role === "admin";
  return admin(ctx.orgRole) || admin(ctx.wsRole);
}
