"use client";
// The Memories panel (memory-collection spec, Memories tab; the mockup's
// steering.js `steeringMemories`, `memRow` and `memFilter`): the filters, the
// bar a selection shows, the table, and the drawer and dialogs it opens.
//
// The server reads the page the filters name, ranked by uses, then by the
// newest use, then by the newest capture (./query.ts). Each filter is an
// address, so a filtered list survives a reload and a shared link, and a
// change starts the list at its first page. A row speaks for every memory
// that says the same thing, and a box sits on a waiting row only. Promote and
// Dismiss act on the selected rows' waiting memories.
//
// No memory steers from here. Promote adds draft records to the memory PR,
// and only its merge changes steering. The bar's Promote is not gold, because
// the header's Write a steering record stays the screen's one primary.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type {
  WorkspaceMemory,
  WorkspaceMemoryDetail,
  WorkspaceMemoryPage,
} from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { linkText, mono } from "@/ui/control-styles";
import { Button } from "@/ui/button";
import { ListSelect } from "@/ui/list-select";
import { PullRequestLink, SafeLink, useNavigate } from "@/ui/navigation";
import { cell, headCell, numericCell } from "@/ui/table";
import { toast } from "@/ui/toast";
import {
  type MemoriesView,
  MEMORY_STATE_FILTERS,
  memoriesLink,
  type SteeringAt,
} from "../view";
import {
  AgentValue,
  HarnessValue,
  hasSignal,
  LastUsedValue,
  type MemoryAgents,
  MemoryStateBadge,
  memoryName,
  memorySub,
  RepoValue,
  subLine,
  UsesValue,
  useMemoryWords,
} from "./cells";
import { DismissDialog } from "./dismiss-dialog";
import { MemoryDrawer } from "./drawer";
import { PromoteDialog } from "./promote-dialog";
import type { MemoryFacets } from "./query";

type Group = WorkspaceMemoryPage["groups"][number];

/** What a dialog acts on: one entry per row, each the row's memories. */
type Dialog = {
  kind: "promote" | "dismiss";
  rows: (readonly WorkspaceMemory[])[];
};

/** The view the panel draws: the page size, the offset and the filters. */
type MemoriesPanelView = {
  rows: number;
  offset: number;
  memories: MemoriesView;
};

/** A row a box sits on: the memory that speaks for it is waiting. */
const selectable = (group: Group) => group.memory.state === "waiting";

function Filters({
  at,
  view,
  facets,
  agents,
  matched,
}: {
  at: SteeringAt;
  view: MemoriesPanelView;
  facets: MemoryFacets;
  agents: MemoryAgents;
  /** Memories the filters match. */
  matched: number;
}) {
  const t = useTranslations("steering.memories");
  const states = useTranslations("steering.memories.states");
  const words = useMemoryWords();
  const navigate = useNavigate();
  const f = view.memories;
  const go = (change: Partial<MemoriesView>) => {
    navigate.push(memoriesLink(at, view, change));
  };
  // A value the URL names stays offered even when no memory holds it now,
  // so the select shows what the list is filtered by.
  const withCurrent = <T extends string>(
    values: readonly T[],
    current: T | null,
  ): readonly T[] =>
    current === null || values.includes(current)
      ? values
      : [current, ...values];
  const agentName = (key: string) =>
    Object.hasOwn(agents, key) ? (agents[key]?.name ?? key) : key;
  return (
    <div
      role="group"
      aria-label={t("filters.label")}
      data-testid="memory-filters"
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3"
    >
      <ListSelect
        aria-label={t("filters.state")}
        data-testid="memory-filter-state"
        size="sm"
        value={f.state}
        items={MEMORY_STATE_FILTERS.map((state) => ({
          value: state,
          label: states(state),
        }))}
        onValue={(next) => {
          const state = MEMORY_STATE_FILTERS.find((s) => s === next);
          if (state !== undefined) go({ state });
        }}
      />
      <ListSelect
        aria-label={t("filters.harness")}
        data-testid="memory-filter-harness"
        size="sm"
        value={f.harness ?? ""}
        items={[
          { value: "", label: t("filters.everyHarness") },
          ...withCurrent(facets.harness, f.harness).map((harness) => ({
            value: harness,
            label: words.harness(harness),
          })),
        ]}
        onValue={(next) => {
          const harness = facets.harness.find((h) => h === next) ?? null;
          go({ harness });
        }}
      />
      <ListSelect
        aria-label={t("filters.agent")}
        data-testid="memory-filter-agent"
        size="sm"
        value={f.agent ?? ""}
        items={[
          { value: "", label: t("filters.everyAgent") },
          ...withCurrent(facets.agent, f.agent).map((agent) => ({
            value: agent,
            label: agentName(agent),
          })),
        ]}
        onValue={(next) => {
          go({ agent: next === "" ? null : next });
        }}
      />
      <ListSelect
        aria-label={t("filters.repo")}
        data-testid="memory-filter-repo"
        size="sm"
        value={f.repo ?? ""}
        items={[
          { value: "", label: t("filters.everyRepo") },
          ...withCurrent(facets.repo, f.repo).map((repo) => ({
            value: repo,
            label: repo,
          })),
        ]}
        onValue={(next) => {
          go({ repo: next === "" ? null : next });
        }}
      />
      <ListSelect
        aria-label={t("filters.type")}
        data-testid="memory-filter-type"
        size="sm"
        value={f.type ?? ""}
        items={[
          { value: "", label: t("filters.everyType") },
          ...withCurrent(facets.type, f.type).map((type) => ({
            value: type,
            label: words.type(type),
          })),
        ]}
        onValue={(next) => {
          go({ type: next === "" ? null : next });
        }}
      />
      <span
        className="ml-auto text-sm text-muted-foreground"
        data-testid="memory-count"
      >
        {t("count", { count: matched })}
      </span>
    </div>
  );
}

function StateCell({ memory }: { memory: WorkspaceMemory }) {
  const t = useTranslations("steering.memories");
  const url =
    memory.state === "in_pr" && memory.memoryPr !== null
      ? parsePullRequestUrl(memory.memoryPr.url)
      : null;
  return (
    <>
      <MemoryStateBadge state={memory.state} />
      {memory.state === "in_pr" && memory.memoryPr !== null ? (
        url === null ? (
          <span className={subLine}>
            {t("prLink", { number: String(memory.memoryPr.number) })}
          </span>
        ) : (
          <PullRequestLink
            to={url}
            className={`${linkText} ${subLine}`}
            data-testid="memory-pr-link"
          >
            {t("prLink", { number: String(memory.memoryPr.number) })}
          </PullRequestLink>
        )
      ) : null}
      {memory.state === "promoted" && memory.promotedLineage !== null ? (
        <span className={`${subLine} ${mono}`} data-truncate="">
          {memory.promotedLineage}
        </span>
      ) : null}
    </>
  );
}

function Row({
  at,
  view,
  group,
  agents,
  readAt,
  checked,
  onCheck,
}: {
  at: SteeringAt;
  view: MemoriesPanelView;
  group: Group;
  agents: MemoryAgents;
  readAt: string;
  checked: boolean;
  onCheck: (checked: boolean) => void;
}) {
  const t = useTranslations("steering.memories");
  const words = useMemoryWords();
  const { memory, members } = group;
  const name = memoryName(memory);
  const sub = memorySub(memory);
  const signal = hasSignal(members);
  const more = members.length - 1;
  return (
    <tr data-memory={memory.id} data-state={memory.state}>
      <td className={`${cell} w-8`}>
        {selectable(group) ? (
          <input
            type="checkbox"
            data-testid="memory-pick"
            aria-label={t("selectRow", { name })}
            checked={checked}
            onChange={(event) => {
              onCheck(event.currentTarget.checked);
            }}
          />
        ) : null}
      </td>
      <td className={cell}>
        <SafeLink
          to={memoriesLink(at, view, { memory: memory.id })}
          className={`${linkText} block max-w-cell-wide truncate`}
          data-truncate=""
          data-testid="memory-open"
        >
          {name}
        </SafeLink>
        {sub === "" ? null : (
          <span className={subLine} data-truncate="">
            {sub}
          </span>
        )}
        {more > 0 ? (
          <span className={subLine}>{t("sameCount", { count: more })}</span>
        ) : null}
      </td>
      <td className={numericCell}>
        <UsesValue uses={group.uses} signal={signal} />
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <LastUsedValue at={group.lastUsedAt} signal={signal} readAt={readAt} />
      </td>
      <td className={cell}>
        <HarnessValue memory={memory} />
        {memory.memoryType === null ? null : (
          <span className={subLine}>{words.type(memory.memoryType)}</span>
        )}
      </td>
      <td className={cell}>
        <AgentValue agent={memory.agent} agents={agents} />
      </td>
      <td className={cell}>
        <RepoValue repos={memory.repos} />
      </td>
      <td className={cell}>
        <StateCell memory={memory} />
      </td>
    </tr>
  );
}

export function MemoriesPanel({
  at,
  view,
  page,
  facets,
  agents,
  openPr,
  detail,
  readAt,
  pager,
}: {
  at: SteeringAt;
  view: MemoriesPanelView;
  page: WorkspaceMemoryPage;
  facets: MemoryFacets;
  agents: MemoryAgents;
  /** The open memory PR a draft joins; null when Promote opens one. */
  openPr: number | null;
  /** get_workspace_memory for the memory the address names; null when it names none. */
  detail: Read<WorkspaceMemoryDetail> | null;
  readAt: string;
  /** The pager under the table, drawn by the server. */
  pager: ReactNode;
}) {
  const t = useTranslations("steering.memories");
  const navigate = useNavigate();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // A selection made before a filter changed holds only the rows still shown.
  const picked = page.groups.filter(
    (group) => selectable(group) && selected.has(group.memory.id),
  );
  const pickable = page.groups.filter(selectable);
  const allPicked =
    pickable.length > 0 && pickable.every((g) => selected.has(g.memory.id));
  const check = (id: string, on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  /** The row a drawer's memory belongs to, or the memory alone. */
  const rowOf = (memory: WorkspaceMemory): readonly WorkspaceMemory[] =>
    page.groups.find((group) =>
      group.members.some((member) => member.id === memory.id),
    )?.members ?? [memory];
  const done = (text: string) => {
    setDialog(null);
    setSelected(new Set());
    toast(text);
    navigate.refresh();
  };
  const filtered =
    view.memories.state !== "open" ||
    view.memories.harness !== null ||
    view.memories.agent !== null ||
    view.memories.repo !== null ||
    view.memories.type !== null;
  return (
    <>
      <Filters
        at={at}
        view={view}
        facets={facets}
        agents={agents}
        matched={page.totalMemories}
      />
      {picked.length === 0 ? null : (
        <div
          role="group"
          aria-label={t("selection.label")}
          data-testid="memory-selection"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-hl px-4 py-2.5 text-sm"
        >
          <b className="font-semibold text-foreground">
            {t("selection.count", { count: picked.length })}
          </b>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              {t("selection.clear")}
            </Button>
            <Button
              type="button"
              data-testid="memory-dismiss"
              variant="outline"
              onClick={() => {
                setDialog({
                  kind: "dismiss",
                  rows: picked.map((g) => g.members),
                });
              }}
            >
              {t("selection.dismiss")}
            </Button>
            <Button
              type="button"
              data-testid="memory-promote"
              variant="outline"
              onClick={() => {
                setDialog({
                  kind: "promote",
                  rows: picked.map((g) => g.members),
                });
              }}
            >
              {t("selection.promote")}
            </Button>
          </span>
        </div>
      )}
      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label={t("title")}
          data-testid="memory-table"
          className="w-full min-w-180 border-collapse text-sm"
        >
          <thead>
            <tr className="border-b border-border">
              <th
                scope="col"
                aria-label={t("columns.select")}
                className={`${headCell} w-8 text-left`}
              >
                <input
                  type="checkbox"
                  data-testid="memory-pick-all"
                  aria-label={t("selectAll")}
                  checked={allPicked}
                  disabled={pickable.length === 0}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const group of pickable) {
                        if (on) next.add(group.memory.id);
                        else next.delete(group.memory.id);
                      }
                      return next;
                    });
                  }}
                />
              </th>
              <th scope="col" className={`${headCell} text-left`}>
                {t("columns.memory")}
              </th>
              <th scope="col" className={`${headCell} text-right`}>
                {t("columns.uses")}
              </th>
              <th scope="col" className={`${headCell} text-left`}>
                {t("columns.lastUsed")}
              </th>
              <th scope="col" className={`${headCell} text-left`}>
                {t("columns.harness")}
              </th>
              <th scope="col" className={`${headCell} text-left`}>
                {t("columns.agent")}
              </th>
              <th scope="col" className={`${headCell} text-left`}>
                {t("columns.repo")}
              </th>
              <th scope="col" className={`${headCell} text-left`}>
                {t("columns.state")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
            {page.groups.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className={`${cell} text-muted-foreground`}
                  data-testid="memory-no-match"
                >
                  {t("noMatch")}{" "}
                  {filtered ? (
                    <SafeLink
                      to={memoriesLink(at, view, {
                        state: "open",
                        harness: null,
                        agent: null,
                        repo: null,
                        type: null,
                      })}
                      className={linkText}
                    >
                      {t("clearFilters")}
                    </SafeLink>
                  ) : null}
                </td>
              </tr>
            ) : (
              page.groups.map((group) => (
                <Row
                  key={group.memory.id}
                  at={at}
                  view={view}
                  group={group}
                  agents={agents}
                  readAt={readAt}
                  checked={selected.has(group.memory.id)}
                  onCheck={(on) => {
                    check(group.memory.id, on);
                  }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {pager}
      {/* The drawer steps aside while a dialog it opened is up, and comes back when the dialog closes. */}
      {detail === null || dialog !== null ? null : (
        <MemoryDrawer
          at={at}
          read={detail}
          closeTo={memoriesLink(at, view, { memory: null })}
          row={detail.ok ? rowOf(detail.value.memory) : []}
          agents={agents}
          readAt={readAt}
          onPromote={(row) => {
            setDialog({ kind: "promote", rows: [row] });
          }}
          onDismiss={(row) => {
            setDialog({ kind: "dismiss", rows: [row] });
          }}
          onRestored={(text) => {
            toast(text);
            navigate.refresh();
          }}
        />
      )}
      {dialog?.kind === "promote" ? (
        <PromoteDialog
          at={at}
          rows={dialog.rows}
          agents={agents}
          openPr={openPr}
          onClose={() => {
            setDialog(null);
          }}
          onDone={done}
        />
      ) : null}
      {dialog?.kind === "dismiss" ? (
        <DismissDialog
          at={at}
          rows={dialog.rows}
          agents={agents}
          onClose={() => {
            setDialog(null);
          }}
          onDone={done}
        />
      ) : null}
    </>
  );
}
