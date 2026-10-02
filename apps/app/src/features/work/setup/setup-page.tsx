// Work setup (roadmap mockups/pages/work-setup.md, mockups/src/work-setup.js
// `workSetupView()`): what Phase 1 reads, how triage ranks it, and which
// agents can take a send, on three tabs. The tab is `?tab=`.
//
// Each tab makes only its own reads. Collectors reads the collectors with the
// repositories linked to the workspace, which are the only ones a collector
// may read, and the work items for what the viewer's roles admit. A failed
// roles read leaves the buttons on and lets the server's refusal speak.
// Priorities reads the priorities record. Runtimes reads which agents can
// take a send.
//
// Phase 1 draws no Workflows, Autonomy or Training tab, and no write-back
// switch.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes, WORK_SETUP_TABS, type WorkSetupTab } from "@/shared/safe-path";
import { PageHeader } from "@/ui/page-header";
import { RouteTabPanel, RouteTabs } from "@/ui/route-tabs";
import { CollectorsTab } from "./collectors";
import { PrioritiesTab } from "./priorities";
import { RuntimesTab } from "./runtimes";

/** The id of the panel under the tab row. */
const SETUP_PANEL = "work-setup-panel";

function SetupView({
  org,
  ws,
  wsName,
  tab,
  children,
}: {
  org: string;
  ws: string;
  wsName: string;
  tab: WorkSetupTab;
  children: ReactNode;
}) {
  const t = useTranslations("work.setup.tabs");
  const pages = useTranslations("pages");
  return (
    <div data-testid="work-setup-page" className="flex flex-col gap-4">
      <PageHeader eyebrow={wsName} title={pages("workSetup")} />
      <RouteTabs
        label={t("label")}
        panel={SETUP_PANEL}
        tabs={WORK_SETUP_TABS.map((name) => ({
          to: routes.workSetup(org, ws, name),
          label: t(name),
          current: name === tab,
          name,
        }))}
      />
      <RouteTabPanel panel={SETUP_PANEL} className="flex flex-col gap-4">
        {children}
      </RouteTabPanel>
    </div>
  );
}

async function tabBody({
  ctx,
  source,
  tab,
}: {
  ctx: WsCtx;
  source: DataSource;
  tab: WorkSetupTab;
}): Promise<ReactNode> {
  const org = ctx.orgSlug;
  const ws = ctx.wsSlug;
  switch (tab) {
    case "collectors": {
      const [collectors, list] = await Promise.all([
        source.work.collectors(ctx),
        source.work.list(ctx),
      ]);
      return (
        <CollectorsTab
          org={org}
          ws={ws}
          read={collectors}
          canControl={list.ok ? list.value.viewer.canControl : true}
        />
      );
    }
    case "priorities":
      return (
        <PrioritiesTab
          org={org}
          ws={ws}
          read={await source.work.priorities(ctx)}
        />
      );
    case "runtimes":
      return (
        <RuntimesTab org={org} ws={ws} read={await source.work.targets(ctx)} />
      );
  }
}

export async function WorkSetupPage({
  ctx,
  source,
  tab,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The tab the URL's `?tab=` resolved to (`parseSetupTab`). */
  tab: WorkSetupTab;
}) {
  const body = await tabBody({ ctx, source, tab });
  return (
    <SetupView org={ctx.orgSlug} ws={ctx.wsSlug} wsName={ctx.wsName} tab={tab}>
      {body}
    </SetupView>
  );
}
