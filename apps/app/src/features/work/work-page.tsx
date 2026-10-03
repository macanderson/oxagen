// The Work page (agent-work-phase-1.html, Screens; roadmap mockups/pages/work.md,
// mockups/src/work.js `VIEWS.work`): every work item from the moment it arrives
// to the moment a person accepts it and its pull request merges, on four tabs.
//
// It makes three reads at once. The work items (list_work_items) feed the
// tiles, the tabs and the tables, and say what the viewer's roles admit. The
// collectors (list_work_collectors) feed the banner a failing collector
// raises. The priorities record (get_work_priorities) feeds the line under
// the heading. A refused or failed item read replaces the body and keeps the
// header. A failed collectors or priorities read drops only what it feeds.
//
// The header carries Setup, Outcomes, New work item, and the page's one gold
// action, Send to an agent. Send opens the first ready Inbox item with its
// Send dialog (`?dialog=send`), where the person picks the agent. A viewer
// whose roles cannot send or enter work sees both buttons disabled with the
// reason, and one note under the header. The server refuses every write the
// roles do not admit, whatever the page draws.
//
// Phase 1 draws no batch, autonomy level, training, Held or Proven word, or
// done-record verdict.
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/ssr";
import { useLocale, useTranslations } from "next-intl";
import type {
  WorkCollector,
  WorkItemList,
  WorkItemRow,
  WorkPriorities,
} from "@/data/contracts/work";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes, WORK_PAGE_TABS, type WorkPageTab } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  buttonSmall,
  linkText,
  note,
  panel,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { RouteTabPanel, RouteTabs } from "@/ui/route-tabs";
import { NewWorkItem } from "./new-item";
import { WorkReadFailure } from "./read-failure";
import {
  groupByTab,
  isSendable,
  type WorkGroups,
  WorkTable,
} from "./work-table";

/** The id of the panel under the tab row. */
const WORK_PANEL = "work-panel";

/** Send to an agent: the first ready Inbox item's Send dialog, or disabled with its reason. */
function SendToAgent({
  org,
  ws,
  item,
  canControl,
}: {
  org: string;
  ws: string;
  item: WorkItemRow | null;
  canControl: boolean;
}) {
  const t = useTranslations("work.page");
  if (canControl && item !== null) {
    return (
      <SafeLink
        to={routes.workItem(org, ws, item.number, { dialog: "send" })}
        data-testid="work-send"
        className={buttonPrimary}
      >
        <PaperPlaneTiltIcon aria-hidden="true" />
        {t("send")}
      </SafeLink>
    );
  }
  const reason = canControl ? t("sendNothingReady") : t("sendNoRole");
  return (
    <>
      <button
        type="button"
        disabled
        data-testid="work-send"
        aria-describedby="work-send-reason"
        title={reason}
        className={buttonPrimary}
      >
        <PaperPlaneTiltIcon aria-hidden="true" />
        {t("send")}
      </button>
      <span id="work-send-reason" className="sr-only">
        {reason}
      </span>
    </>
  );
}

/** The banner a failing collector raises: what it reads and its last good read. */
function CollectorBanner({
  org,
  ws,
  failing,
}: {
  org: string;
  ws: string;
  failing: readonly WorkCollector[];
}) {
  const t = useTranslations("work.banner");
  const format = useFormatter();
  const when = (at: string) =>
    format.dateTime(new Date(at), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <div
      data-testid="work-collector-banner"
      className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-[10px] border border-error/40 bg-error/10 px-3.5 py-[11px] text-base text-foreground"
    >
      <div className="flex min-w-0 grow flex-col gap-1">
        {failing.map((collector) => (
          <p key={collector.name} data-collector={collector.name}>
            <b className="font-semibold">
              {t("failing", { name: collector.name })}
            </b>{" "}
            {collector.repos.length === 0
              ? null
              : `${t("reads", { repos: format.list(collector.repos) })} `}
            {collector.lastSuccessAt === null
              ? t("neverGood")
              : t("lastGood", { at: when(collector.lastSuccessAt) })}
          </p>
        ))}
      </div>
      <SafeLink
        to={routes.workSetup(org, ws, "collectors")}
        data-touch-target=""
        className={buttonSmall}
      >
        {t("open")}
      </SafeLink>
    </div>
  );
}

function Tile({
  testId,
  term,
  value,
  sub,
}: {
  testId: string;
  term: string;
  value: string;
  sub: string;
}) {
  return (
    <div data-testid={testId} className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={statValue}>{value}</dd>
      <dd className={statNote}>{sub}</dd>
    </div>
  );
}

/** The tiles, the tab row and the open tab's table. */
function WorkBody({
  org,
  ws,
  tab,
  list,
  groups,
}: {
  org: string;
  ws: string;
  tab: WorkPageTab;
  list: WorkItemList;
  groups: WorkGroups;
}) {
  const t = useTranslations("work");
  const locale = useLocale();
  const ready = groups.inbox.filter(isSendable).length;
  const waitingForRuntime = groups.running.filter(
    (item) => item.state === "sent",
  ).length;
  const waitingForMerge = groups.review.filter(
    (item) => item.status === "accepted",
  ).length;
  return (
    <>
      <dl aria-label={t("tiles.label")} className={statStrip}>
        <Tile
          testId="work-tile-ready"
          term={t("tiles.ready")}
          value={formatCount(ready, locale)}
          sub={t("tiles.readyNote", { count: groups.inbox.length - ready })}
        />
        <Tile
          testId="work-tile-running"
          term={t("tiles.running")}
          value={formatCount(groups.running.length, locale)}
          sub={t("tiles.runningNote", { count: waitingForRuntime })}
        />
        <Tile
          testId="work-tile-review"
          term={t("tiles.review")}
          value={formatCount(groups.review.length - waitingForMerge, locale)}
          sub={t("tiles.reviewNote", { count: waitingForMerge })}
        />
      </dl>
      <RouteTabs
        label={t("tabs.label")}
        panel={WORK_PANEL}
        tabs={WORK_PAGE_TABS.map((name) => ({
          to: routes.work(org, ws, name),
          label: t(`tabs.${name}`),
          current: name === tab,
          name,
          count: formatCount(groups[name].length, locale),
        }))}
      />
      <RouteTabPanel panel={WORK_PANEL} className={panel}>
        <WorkTable
          org={org}
          ws={ws}
          tab={tab}
          items={groups[tab]}
          canControl={list.viewer.canControl}
        />
      </RouteTabPanel>
      {list.truncated ? (
        <p
          data-testid="work-truncated"
          className="text-sm text-muted-foreground"
        >
          {t("page.truncated", { count: list.items.length })}
        </p>
      ) : null}
    </>
  );
}

function WorkView({
  org,
  ws,
  wsName,
  tab,
  list,
  failing,
  priorities,
}: {
  org: string;
  ws: string;
  wsName: string;
  tab: WorkPageTab;
  list: Read<WorkItemList>;
  failing: readonly WorkCollector[];
  priorities: WorkPriorities | null;
}) {
  const t = useTranslations("work");
  const pages = useTranslations("pages");
  const value = list.ok ? list.value : null;
  const groups = value === null ? null : groupByTab(value.items);
  const viewer = value === null ? null : value.viewer;
  const record = priorities?.record ?? null;
  const description =
    priorities === null
      ? undefined
      : record === null
        ? t.rich("page.descriptionNoRecordLink", {
            record: (chunks) => (
              <SafeLink
                to={routes.workSetup(org, ws, "priorities")}
                data-testid="work-write-priorities"
                className={linkText}
              >
                {chunks}
              </SafeLink>
            ),
          })
        : t.rich("page.description", {
            lineage: record.lineage,
            version: String(record.version),
            record: (chunks) => (
              <SafeLink
                to={routes.workSetup(org, ws, "priorities")}
                className={linkText}
              >
                {chunks}
              </SafeLink>
            ),
          });
  return (
    <div data-testid="work-page" className="flex flex-col gap-4">
      <PageHeader
        eyebrow={wsName}
        title={pages("work")}
        description={description}
        actions={
          <>
            <SafeLink
              to={routes.workSetup(org, ws)}
              data-testid="work-open-setup"
              className={buttonSecondary}
            >
              {t("page.setup")}
            </SafeLink>
            <SafeLink
              to={routes.workOutcomes(org, ws)}
              data-testid="work-open-outcomes"
              className={buttonSecondary}
            >
              {t("page.outcomes")}
            </SafeLink>
            {viewer === null || groups === null ? null : (
              <>
                <NewWorkItem org={org} ws={ws} canControl={viewer.canControl} />
                <SendToAgent
                  org={org}
                  ws={ws}
                  item={groups.inbox.find(isSendable) ?? null}
                  canControl={viewer.canControl}
                />
              </>
            )}
          </>
        }
      />
      {viewer === null || viewer.canControl ? null : (
        <p data-testid="work-viewer-note" className={note}>
          {t("page.viewerNote")}
        </p>
      )}
      {failing.length === 0 ? null : (
        <CollectorBanner org={org} ws={ws} failing={failing} />
      )}
      {list.ok && groups !== null ? (
        <WorkBody
          org={org}
          ws={ws}
          tab={tab}
          list={list.value}
          groups={groups}
        />
      ) : list.ok ? null : (
        <WorkReadFailure
          read={list}
          page={pages("work")}
          retry={routes.work(org, ws, tab)}
        />
      )}
    </div>
  );
}

export async function WorkPage({
  ctx,
  source,
  tab,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The tab the URL's `?tab=` resolved to (`parseWorkTab`). */
  tab: WorkPageTab;
}) {
  const [list, collectors, priorities] = await Promise.all([
    source.work.list(ctx),
    source.work.collectors(ctx),
    source.work.priorities(ctx),
  ]);
  return (
    <WorkView
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      wsName={ctx.wsName}
      tab={tab}
      list={list}
      failing={
        collectors.ok
          ? collectors.value.collectors.filter(
              (collector) => collector.health === "failing",
            )
          : []
      }
      priorities={priorities.ok ? priorities.value : null}
    />
  );
}
