// The Work page's four tables (roadmap mockups/src/work.js `workTable()`,
// `inboxItems()`, `wrkByTab()`; mockups/pages/work.md). Each row opens the work
// item: its title is a link stretched over the row. The Work item cell holds
// the item's number in mono, its title as text, and the line that says what
// it waits for. On Inbox the labels follow as quiet chips. On Review the pull
// request cell lists every pull request the forge store holds for the send,
// each with its state (ADR-292), over the head the send's facts name. With no
// forge row yet, it shows the pull request the facts name.
//
// The server decides which tab each item sits on (`item.tab`) and its status
// word. This module only orders the rows. Inbox puts a failed triage first,
// because it needs a person, then P0 to P3, then items with no priority, and
// items still in triage last, oldest first within each group. Done lists the
// newest finished item first. Running and Review keep the server's order.
//
// The text an item carries (its title, its labels) comes from outside the
// workspace, so it is drawn as text and nothing reads it as markup. On a phone
// the shell turns each table into labelled cards (features/shell/card-tables.ts),
// so no column is hidden by width and nothing scrolls sideways.
import { useTranslations } from "next-intl";
import type { WorkItemRow, WorkTab } from "@/data/contracts/work";
import { routes, type WorkPageTab } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSmall, mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { StateWrap } from "@/ui/state-wrap";
import { cell, numericCell, Table } from "@/ui/table";
import { NewWorkItem } from "./new-item";
import {
  ChecksBadge,
  CostText,
  PriorityCell,
  PullStateBadge,
  shortSha,
  WaitLine,
  WorkStatusBadge,
} from "./words";

/** The items of each tab, in the order the tab lists them. */
export type WorkGroups = Readonly<Record<WorkTab, readonly WorkItemRow[]>>;

const PRIORITY_RANK = { P0: 1, P1: 2, P2: 3, P3: 4 } as const;

/** Where an Inbox item sorts: a failed triage leads and an item in triage trails. */
function inboxRank(item: WorkItemRow): number {
  if (item.status === "triage_failed") return 0;
  if (item.status === "triaging") return 6;
  return item.priority.label === null ? 5 : PRIORITY_RANK[item.priority.label];
}

/** Inbox order: by rank, then the oldest arrival first. */
function inboxOrder(items: readonly WorkItemRow[]): WorkItemRow[] {
  return [...items].sort(
    (a, b) =>
      inboxRank(a) - inboxRank(b) ||
      Date.parse(a.arrivedAt) - Date.parse(b.arrivedAt),
  );
}

/** Done order: the newest finished item first. */
function doneOrder(items: readonly WorkItemRow[]): WorkItemRow[] {
  const finished = (item: WorkItemRow) =>
    Date.parse(item.finishedAt ?? item.arrivedAt);
  return [...items].sort((a, b) => finished(b) - finished(a));
}

/** Every item on the tab the server put it on, each tab in its own order. */
export function groupByTab(items: readonly WorkItemRow[]): WorkGroups {
  const groups: Record<WorkTab, WorkItemRow[]> = {
    inbox: [],
    running: [],
    review: [],
    done: [],
  };
  for (const item of items) groups[item.tab].push(item);
  return {
    inbox: inboxOrder(groups.inbox),
    running: groups.running,
    review: groups.review,
    done: doneOrder(groups.done),
  };
}

/**
 * Whether the item can be sent now: its brief is approved for the current
 * source and nothing is in flight. A send the runtime refused leaves the item
 * ready, so it can go out again.
 */
export function isSendable(item: WorkItemRow): boolean {
  return item.state === "ready";
}

function useWhen(): (at: string) => string {
  const format = useFormatter();
  return (at) =>
    format.dateTime(new Date(at), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
}

/** The item's number and title (the row's link), what it waits for, and on Inbox its labels. */
function ItemCell({
  org,
  ws,
  item,
  labels,
}: {
  org: string;
  ws: string;
  item: WorkItemRow;
  labels: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <SafeLink
        to={routes.workItem(org, ws, item.number)}
        data-touch-target=""
        className="inline-flex max-w-full items-baseline gap-2 rounded-sm font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className={`${mono} flex-none text-muted-foreground`}>
          {item.number}
        </span>{" "}
        <span className="min-w-0 wrap-anywhere">{item.title}</span>
      </SafeLink>
      <WaitLine wait={item.wait} />
      {labels && item.labels.length > 0 ? (
        <span className="flex flex-wrap gap-1 pt-0.5">
          {item.labels.map((label) => (
            <Badge key={label} tone="quiet" dot={false} data-work-label={label}>
              {label}
            </Badge>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function Muted({ children }: { children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** A row that opens its item: the title link is stretched over it. */
const ROW = "relative cursor-pointer";

function InboxTable({
  org,
  ws,
  items,
  canControl,
}: {
  org: string;
  ws: string;
  items: readonly WorkItemRow[];
  canControl: boolean;
}) {
  const t = useTranslations("work");
  return (
    <Table
      label={t("tabs.inbox")}
      columns={[
        { label: t("table.columns.item") },
        { label: t("table.columns.priority") },
        { label: t("table.columns.state") },
        { label: t("table.columns.send"), hidden: true },
      ]}
    >
      {items.map((item) => (
        <tr key={item.id} data-work-item={item.number} data-status={item.status} data-wait={item.wait.kind} className={ROW}>
          <td className={cell}>
            <ItemCell org={org} ws={ws} item={item} labels />
          </td>
          <td className={cell}>
            <PriorityCell priority={item.priority} />
          </td>
          <td className={cell}>
            <WorkStatusBadge status={item.status} />
          </td>
          <td className={`${cell} text-right`}>
            {canControl && isSendable(item) ? (
              <SafeLink
                to={routes.workItem(org, ws, item.number, { dialog: "send" })}
                aria-label={t("table.sendItem", { number: item.number })}
                data-testid="work-send-row"
                data-touch-target=""
                className={`${buttonSmall} relative z-10`}
              >
                {t("table.send")}
              </SafeLink>
            ) : null}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function RunningTable({
  org,
  ws,
  items,
}: {
  org: string;
  ws: string;
  items: readonly WorkItemRow[];
}) {
  const t = useTranslations("work");
  const when = useWhen();
  return (
    <Table
      label={t("tabs.running")}
      columns={[
        { label: t("table.columns.item") },
        { label: t("table.columns.target") },
        { label: t("table.columns.status") },
        { label: t("table.columns.cost"), numeric: true },
      ]}
    >
      {items.map((item) => (
        <tr key={item.id} data-work-item={item.number} data-status={item.status} data-wait={item.wait.kind} className={ROW}>
          <td className={cell}>
            <ItemCell org={org} ws={ws} item={item} labels={false} />
          </td>
          <td className={cell}>
            {item.send === null ? (
              <Muted>{t("table.none")}</Muted>
            ) : (
              <span className="flex flex-col">
                <span>{item.send.agent.name ?? t("table.none")}</span>
                {item.send.runtime.name === null ? null : (
                  <span className="text-sm text-muted-foreground">
                    {item.send.runtime.name}
                  </span>
                )}
              </span>
            )}
          </td>
          <td className={cell}>
            <span className="flex flex-col items-start gap-1">
              <WorkStatusBadge status={item.status} />
              {item.send === null ? null : (
                <span className="text-sm text-muted-foreground">
                  {t("table.sentOn", { at: when(item.send.requestedAt) })}
                </span>
              )}
            </span>
          </td>
          <td className={numericCell}>
            <CostText cost={item.cost} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

function ReviewTable({
  org,
  ws,
  items,
}: {
  org: string;
  ws: string;
  items: readonly WorkItemRow[];
}) {
  const t = useTranslations("work");
  return (
    <Table
      label={t("tabs.review")}
      columns={[
        { label: t("table.columns.item") },
        { label: t("table.columns.pullRequest") },
        { label: t("table.columns.checks") },
        { label: t("table.columns.cost"), numeric: true },
      ]}
    >
      {items.map((item) => {
        const pr = item.send?.pullRequest ?? null;
        const pulls = item.send?.pullRequests ?? [];
        const head = pr?.head ?? null;
        return (
          <tr key={item.id} data-work-item={item.number} data-status={item.status} data-wait={item.wait.kind} className={ROW}>
            <td className={cell}>
              <ItemCell org={org} ws={ws} item={item} labels={false} />
            </td>
            <td className={cell}>
              {pulls.length > 0 ? (
                <span className="flex flex-col gap-1">
                  {pulls.map((pull) => (
                    <span key={pull.id} className="flex flex-wrap items-center gap-2" data-pull-request={pull.number}>
                      <span className={mono}>
                        {t("table.pullRequest", { number: String(pull.number) })}
                      </span>
                      <PullStateBadge pull={pull} />
                    </span>
                  ))}
                  {head === null ? null : (
                    <span className={`${mono} text-sm text-muted-foreground`}>
                      {shortSha(head)}
                    </span>
                  )}
                </span>
              ) : pr === null ? (
                <Muted>{t("table.none")}</Muted>
              ) : (
                <span className="flex flex-col" data-pull-request={pr.number}>
                  <span className={mono}>
                    {t("table.pullRequest", { number: String(pr.number) })}
                  </span>
                  {pr.head === null ? null : (
                    <span className={`${mono} text-sm text-muted-foreground`}>
                      {shortSha(pr.head)}
                    </span>
                  )}
                </span>
              )}
            </td>
            <td className={cell}>
              {item.send === null ? (
                <Muted>{t("table.none")}</Muted>
              ) : (
                <ChecksBadge word={item.send.checks} />
              )}
            </td>
            <td className={numericCell}>
              <CostText cost={item.cost} />
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function DoneTable({
  org,
  ws,
  items,
}: {
  org: string;
  ws: string;
  items: readonly WorkItemRow[];
}) {
  const t = useTranslations("work");
  const when = useWhen();
  return (
    <Table
      label={t("tabs.done")}
      columns={[
        { label: t("table.columns.item") },
        { label: t("table.columns.result") },
        { label: t("table.columns.agent") },
        { label: t("table.columns.cost"), numeric: true },
        { label: t("table.columns.finished") },
      ]}
    >
      {items.map((item) => {
        const agent = item.send?.agent.name ?? null;
        return (
          <tr key={item.id} data-work-item={item.number} data-status={item.status} data-wait={item.wait.kind} className={ROW}>
            <td className={cell}>
              <ItemCell org={org} ws={ws} item={item} labels={false} />
            </td>
            <td className={cell}>
              <WorkStatusBadge status={item.status} />
            </td>
            <td className={cell}>
              {agent === null ? <Muted>{t("table.none")}</Muted> : agent}
            </td>
            <td className={numericCell}>
              <CostText cost={item.cost} />
            </td>
            <td className={`${cell} whitespace-nowrap`}>
              {item.finishedAt === null ? (
                <Muted>{t("table.none")}</Muted>
              ) : (
                when(item.finishedAt)
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function EmptyTab({
  org,
  ws,
  tab,
  canControl,
}: {
  org: string;
  ws: string;
  tab: WorkPageTab;
  canControl: boolean;
}) {
  const t = useTranslations("work.empty");
  return (
    <StateWrap
      tone="neutral"
      testId={`work-empty-${tab}`}
      title={t(`${tab}.title`)}
      actions={
        tab === "inbox" && canControl ? (
          <NewWorkItem
            org={org}
            ws={ws}
            canControl
            testId="work-new-item-empty"
          />
        ) : undefined
      }
    >
      {t(`${tab}.body`)}
    </StateWrap>
  );
}

/** The table of the open tab, or its empty state. */
export function WorkTable({
  org,
  ws,
  tab,
  items,
  canControl,
}: {
  org: string;
  ws: string;
  tab: WorkPageTab;
  items: readonly WorkItemRow[];
  canControl: boolean;
}) {
  if (items.length === 0)
    return <EmptyTab org={org} ws={ws} tab={tab} canControl={canControl} />;
  switch (tab) {
    case "inbox":
      return (
        <InboxTable org={org} ws={ws} items={items} canControl={canControl} />
      );
    case "running":
      return <RunningTable org={org} ws={ws} items={items} />;
    case "review":
      return <ReviewTable org={org} ws={ws} items={items} />;
    case "done":
      return <DoneTable org={org} ws={ws} items={items} />;
  }
}
