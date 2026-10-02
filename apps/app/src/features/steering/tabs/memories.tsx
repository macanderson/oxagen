// Memories (memory-collection spec, Memories tab; roadmap
// pages/steering-memories.md; #4914): every memory the workspace's agents
// wrote in their harnesses' own stores, ranked by the runs that used each
// one, with the filters, the drawer, Promote and Dismiss.
//
// A memory steers only the agent that wrote it, through its harness. It
// reaches other agents only as a record in a memory PR, once a person
// promotes it and the PR merges. Oxagen's own assistant never receives these
// memories, so they stay apart from the Library's Assistant memory shelf.
//
// The tab reads every memory in every state first (../memories/query.ts):
// each filter lists the values those memories hold, and a workspace with
// none shows "No memories yet" while a filter that matches nothing says so.
// A failed read shows in the panel with Try again, and the other tabs keep
// working, because the hub's own reads did not fail.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { buttonSecondary, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import type { MemoryAgents } from "../memories/cells";
import { MemoriesPanel } from "../memories/panel";
import {
  EVERY_MEMORY,
  facetsOf,
  openMemoryPr,
  pageQuery,
} from "../memories/query";
import { ShelfEmpty } from "../page-state";
import { SteeringReadFailure } from "../read-failure";
import { Pager } from "../section";
import {
  memoriesLink,
  NO_MEMORY_FILTERS,
  type SteeringAt,
  type SteeringView,
} from "../view";

/** The panel's heading and the one line under it, around its body. */
function Frame({ children }: { children: ReactNode }) {
  const t = useTranslations("steering.memories");
  return (
    <section
      aria-labelledby="memories-title"
      className={panel}
      data-testid="tab-memories"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border bg-panel-head px-4 py-3">
        <h3
          id="memories-title"
          className="text-sm font-semibold text-foreground"
        >
          {t("title")}
        </h3>
        <span className="text-[12.5px] text-muted-foreground">
          {t("lead")}
        </span>
      </div>
      {children}
    </section>
  );
}

function Failed({
  read,
  retry,
}: {
  read: Exclude<Read<unknown>, { ok: true }>;
  retry: ReturnType<typeof memoriesLink>;
}) {
  const t = useTranslations("steering.memories");
  return (
    <Frame>
      <div
        className="flex flex-col items-start gap-3 px-4 py-3.5"
        data-testid="memories-failure"
      >
        <SteeringReadFailure read={read} section={t("title")} />
        <SafeLink to={retry} className={buttonSecondary}>
          {t("retry")}
        </SafeLink>
      </div>
    </Frame>
  );
}

function Empty() {
  const t = useTranslations("steering.memories.empty");
  return (
    <ShelfEmpty testId="memories-empty" title={t("title")}>
      {t("body")}
    </ShelfEmpty>
  );
}

export async function MemoriesTab({
  ctx,
  source,
  at,
  view,
  readAt,
}: {
  ctx: WsCtx;
  source: DataSource;
  at: SteeringAt;
  view: Pick<SteeringView, "rows" | "offset" | "memories">;
  /** The instant the page read, which each "3 days ago" counts from. */
  readAt: string;
}) {
  const shown = { ...view, memories: view.memories ?? NO_MEMORY_FILTERS };
  const filters = shown.memories;
  const [every, page, detail, agents] = await Promise.all([
    source.steering.workspaceMemories(ctx, EVERY_MEMORY),
    source.steering.workspaceMemories(
      ctx,
      pageQuery(filters, shown.offset, shown.rows),
    ),
    filters.memory === null
      ? null
      : source.steering.workspaceMemory(ctx, filters.memory),
    // The hub reads the same first page for the Assignments count, so the
    // kernel answers this one without a second invoke.
    source.agents.list(ctx, { cursor: null }),
  ]);
  const retry = memoriesLink(at, shown, {});
  if (!every.ok) return <Failed read={every} retry={retry} />;
  if (every.value.totalMemories === 0) return <Empty />;
  if (!page.ok) return <Failed read={page} retry={retry} />;
  // An agent the first page of the registry does not hold reads by its key.
  const byKey: MemoryAgents = agents.ok
    ? Object.fromEntries(
        agents.value.agents.flatMap((agent) =>
          agent.agentKey === null
            ? []
            : [
                [
                  agent.agentKey,
                  {
                    name: agent.name,
                    operator: agent.operatorName,
                    harness: agent.harness,
                  },
                ],
              ],
        ),
      )
    : {};
  return (
    <Frame>
      <MemoriesPanel
        at={at}
        view={shown}
        page={page.value}
        facets={facetsOf(every.value)}
        agents={byKey}
        openPr={openMemoryPr(every.value)}
        detail={detail}
        readAt={readAt}
        pager={
          <div className="px-4 py-2">
            <Pager
              offset={shown.offset}
              rows={shown.rows}
              shown={page.value.groups.length}
              total={page.value.totalGroups}
              link={(to) => memoriesLink(at, shown, { ...to, memory: null })}
            />
          </div>
        }
      />
    </Frame>
  );
}
