// Existing steering reads grouped under the Library, Proposals, Freshness and
// Delivery.
import { Suspense } from "react";
import { useTranslations } from "next-intl";
import { firstParam } from "@/shared/safe-path";
import type { Read } from "@/data/read";
import type { SteeringFreshness } from "@/data/contracts/steering";
import type { DataSource } from "@/data/ports";
import { GovernanceLink, LibraryShelves, ProposalSections } from "./hub";
import { PageRecord } from "@/features/shell";
import { Skills, SkillsLoading } from "@/features/skills";
import type { WsCtx } from "@/server/viewer";
import { ContextPrs } from "./context-prs";
import { Deliveries } from "./deliveries";
import { Freshness } from "./freshness";
import { Proposals } from "./proposals";
import { SteeringReadFailure } from "./read-failure";
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
    <SteeringReadFailure read={read} section={t("settings")} />
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
    case "deliveries":
      return <Deliveries read={await source.steering.deliveries(ctx)} />;
    case "freshness":
      return (
        <SettingsPanel
          read={await source.steering.freshness(ctx)}
          at={at}
          canEdit={canEditGates(ctx)}
        />
      );
    case "library": {
      if (view.shelf === "skills")
        return (
          <Skills
            ctx={ctx}
            source={source}
            cursor={view.cursor}
            view={skillView}
          />
        );
      const kind = view.shelf === "memory" ? "memory" : view.kind;
      const read = await source.steering.records(ctx, {
        kind,
        offset: view.offset,
      });
      return (
        <>
          <Records
            at={at}
            shelf={view.shelf}
            kind={kind}
            offset={view.offset}
            read={read}
          />
          {view.shelf === "all" ? (
            <Suspense fallback={<SkillsLoading />}>
              <Skills ctx={ctx} source={source} cursor={null} />
            </Suspense>
          ) : null}
        </>
      );
    }
    case "proposals": {
      const [read, pr] = await Promise.all([
        source.steering.proposals(ctx, { offset: view.offset }),
        view.proposal === null
          ? null
          : source.steering.contextPr(ctx, view.proposal),
      ]);
      return view.section === "prs" ? (
        <ContextPrs
          at={at}
          offset={view.offset}
          read={read}
          selected={view.proposal}
          pr={pr}
        />
      ) : (
        <Proposals at={at} offset={view.offset} read={read} />
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
  /** Selectors from the canonical path and preserved legacy query. */
  searchParams: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const view = parseSteeringView(searchParams);
  const at: SteeringAt = { org: ctx.orgSlug, ws: ctx.wsSlug };
  return (
    <div className="flex flex-col gap-6">
      {/* `proposal` selects nothing off the Context PRs tab, so the parse
          decides this, not the query string. */}
      <PageRecord route="steering" id={view.proposal} />
      <GovernanceLink at={at} />
      <SteeringTabs at={at} current={view.tab} />
      {view.tab === "library" ? (
        <LibraryShelves at={at} current={view.shelf} />
      ) : null}
      {view.tab === "proposals" ? (
        <ProposalSections at={at} current={view.section} />
      ) : null}
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
