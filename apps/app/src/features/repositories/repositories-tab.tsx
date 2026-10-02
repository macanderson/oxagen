"use client";
// The Repositories tab (mockup `repoTab()`; MC spec §10.1, §11.2): every
// repository this workspace binds, main first, and every repository the
// installation reaches that it does not, as `not linked`. Role is the
// workspace's word, not GitHub's. Every row opens the repository dialog: a
// click anywhere on it, or its name, which is the button a keyboard reaches.
//
// Bound rows are local facts (`list_repositories` makes no GitHub call), so
// the table draws while GitHub is down. The `.oxagen/` column is a live read
// per bound repository (`get_repository_tree`); a repository that is not
// linked has no binding to read through, so its tree reads as not read. The
// delivery counters and the code graph have no store yet and say so.
//
// The Issues column turns issue collection on or off for each linked GitHub
// repository: on, oxagen reads its open issues into Work as work items. A
// repository that is not linked takes no switch, because a collector reads
// only linked repositories. The column reads list_work_collectors; when that
// read fails, each switch says the state is unknown and stays off.
import { FolderSimpleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import {
  ListBar,
  type ListFilter,
  ListPager,
  useList,
} from "@/ui/list-controls";
import { FormAlert } from "@/ui/form-feedback";
import { cell, headCell } from "@/ui/table";
import { setIssueCollection } from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { buttonSmall, code, type Load, note, Panel } from "./parts";
import { type RepositoryRow, treeState, type TreeState } from "./view";

/** A `.oxagen/` state as a dot and a word. */
export function TreeBadge({
  state,
  testId,
}: {
  state: TreeState;
  testId?: string;
}) {
  const t = useTranslations("repositories.repos.tree");
  switch (state) {
    case "governed":
      return (
        <Badge tone="allowed" data-testid={testId} data-tree={state}>
          {t("governed")}
        </Badge>
      );
    case "branchMissing":
      return (
        <Badge tone="failed" data-testid={testId} data-tree={state}>
          {t("branchMissing")}
        </Badge>
      );
    case "reading":
      return (
        <Badge tone="quiet" dot={false} data-testid={testId} data-tree={state}>
          {t("reading")}
        </Badge>
      );
    case "unread":
    case "unknown":
      return (
        <Badge
          tone="quiet"
          dot={false}
          data-testid={testId}
          data-tree={state}
          data-state="not-recorded"
        >
          {t("unread")}
        </Badge>
      );
    case "absent":
      return (
        <Badge tone="quiet" data-testid={testId} data-tree={state}>
          {t("absent")}
        </Badge>
      );
  }
}

function RoleBadge({ role }: { role: RepositoryRow["role"] }) {
  const t = useTranslations("repositories.repos.roles");
  return role === "main" ? (
    <Badge tone="proven" dot={false} data-role={role}>
      {t("main")}
    </Badge>
  ) : (
    <span className={role === "available" ? "opacity-70" : ""}>
      <Badge tone="quiet" dot={false} data-role={role}>
        {t(role)}
      </Badge>
    </span>
  );
}

/** The rows' linked repositories that carry no `.oxagen/` on a readable branch. */
function ungoverned(rows: readonly RepositoryRow[]): RepositoryRow[] {
  return rows.filter(
    (row) => row.role === "linked" && treeState(row.tree) === "absent",
  );
}

/** A row oxagen can collect issues from: linked, and on GitHub. */
function collectable(row: RepositoryRow): boolean {
  return row.role !== "available" && row.htmlUrl.startsWith("https://github.com/");
}

/** The switch that turns issue collection on or off for one linked GitHub repository. */
function IssuesSwitch({
  org,
  ws,
  row,
  issues,
  onChanged,
}: {
  org: string;
  ws: string;
  row: RepositoryRow;
  issues: Load<{ collected: string[] }>;
  onChanged: (message: string) => void;
}) {
  const t = useTranslations("repositories.repos.issues");
  const failureText = useRepositoriesFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!collectable(row)) return null;
  const known = issues.kind === "ready";
  const on =
    known && issues.value.collected.includes(row.fullName.toLowerCase());

  async function flip() {
    if (pending || !known) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await setIssueCollection(org, ws, {
        repository: row.fullName,
        collect: !on,
      });
      if (result.ok) {
        onChanged(
          result.value.collecting
            ? t(result.value.reconcileQueued ? "onReading" : "on", {
                repository: row.fullName,
              })
            : t("off", { repository: row.fullName }),
        );
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-disabled={pending || !known || undefined}
        aria-label={t("label", { repository: row.fullName })}
        data-testid={`repository-issues-${row.fullName}`}
        onClick={(event) => {
          event.stopPropagation();
          void flip();
        }}
        className="inline-flex min-h-8 items-center gap-2 rounded-md px-1 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11"
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex h-4 w-8 flex-none items-center rounded-full border transition-colors ${
            on ? "border-success/60 bg-success/15" : "border-border bg-muted"
          }`}
        >
          <span
            className={`absolute size-3 rounded-full transition-transform motion-reduce:transition-none ${
              on ? "translate-x-[1.05rem] bg-success" : "translate-x-0.5 bg-muted-foreground"
            }`}
          />
        </span>
        {pending ? t("saving") : !known ? t("unknown") : on ? t("stateOn") : t("stateOff")}
      </button>
      {failure === null ? null : (
        <FormAlert testId={`repository-issues-failure-${row.fullName}`}>
          {failure}
        </FormAlert>
      )}
    </div>
  );
}

export function RepositoriesTab({
  org,
  ws,
  rows,
  issues,
  onIssuesChanged,
  reachableUnread,
  truncated,
  onOpen,
  onAddOxagen,
}: {
  org: string;
  ws: string;
  rows: RepositoryRow[];
  /** Which linked repositories a collector reads (list_work_collectors). */
  issues: Load<{ collected: string[] }>;
  /** A switch changed what a collector reads; the message says what. */
  onIssuesChanged: (message: string) => void;
  /** The installation listing did not answer, so not-linked rows are missing. */
  reachableUnread: boolean;
  truncated: boolean;
  onOpen: (fullName: string) => void;
  /** Open the init wizard, on one repository or on none. */
  onAddOxagen: (fullName: string | null) => void;
}) {
  const t = useTranslations("repositories.repos");
  const page = useTranslations("repositories.page");
  const bare = ungoverned(rows);
  const filters: ListFilter<RepositoryRow>[] = [
    {
      key: "role",
      label: t("columns.role"),
      options: (["main", "linked", "available"] as const).map((role) => ({
        value: role,
        label: t(`roles.${role}`),
      })),
      get: (row) => row.role,
    },
    {
      key: "oxagen",
      label: t("columns.oxagen"),
      options: [
        { value: "governed", label: t("tree.governed") },
        { value: "absent", label: t("tree.absent") },
      ],
      get: (row) => treeState(row.tree),
    },
  ];
  const list = useList(rows, {
    text: (row) => `${row.fullName} ${row.productionBranch} ${row.role}`,
    filters,
  });
  return (
    <div className="flex flex-col gap-3.5">
      {bare.length === 0 ? null : (
        <div
          role="note"
          data-testid="repositories-ungoverned"
          className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-hl px-4 py-3"
        >
          <Badge tone="approval">
            {t("bannerBadge", { count: bare.length })}
          </Badge>
          <div className="min-w-0 flex-1 text-sm text-muted-foreground">
            <b className="text-foreground">
              {t("bannerLead", {
                repositories: bare.map((row) => row.fullName).join(", "),
              })}
            </b>{" "}
            {t.rich("bannerBody", { code })}
          </div>
          <button
            type="button"
            data-testid="repositories-ungoverned-add"
            aria-haspopup="dialog"
            onClick={() => {
              onAddOxagen(bare[0]?.fullName ?? null);
            }}
            className={buttonSmall}
          >
            {t("addOxagenShort")}
          </button>
        </div>
      )}
      <Panel
        id="repositories-panel"
        testId="repositories-panel"
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <button
            type="button"
            data-testid="repositories-panel-add"
            aria-haspopup="dialog"
            onClick={() => {
              onAddOxagen(null);
            }}
            className={buttonSmall}
          >
            {page("addOxagen")}
          </button>
        }
      >
        <ListBar
          list={list}
          searchLabel={t("search")}
          filters={filters}
          allLabel={(column) => t("all", { column })}
        />
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-label={t("label")}
            data-testid="repositories-table"
            className="w-full min-w-[820px] border-collapse text-sm"
          >
            <thead>
              <tr className="border-b border-border">
                {(
                  [
                    "repository",
                    "role",
                    "productionBranch",
                    "oxagen",
                    "issues",
                    "events",
                    "symbols",
                    "action",
                  ] as const
                ).map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className={`${headCell} ${column === "symbols" ? "text-right" : "text-left"}`}
                  >
                    {column === "action" ? (
                      <span className="sr-only">{t("columns.action")}</span>
                    ) : (
                      t(`columns.${column}`)
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.shown.length === 0 ? (
                <tr>
                  <td colSpan={8} className={`${cell} text-dim`}>
                    {t("nothing")}
                  </td>
                </tr>
              ) : (
                list.shown.map((row) => (
                  <Row
                    key={row.fullName}
                    org={org}
                    ws={ws}
                    row={row}
                    issues={issues}
                    onIssuesChanged={onIssuesChanged}
                    onOpen={onOpen}
                    onAddOxagen={onAddOxagen}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        <ListPager
          list={list}
          label={t("pager")}
          rowsLabel={t("rows")}
          range={(from, to, total) => t("range", { from, to, total })}
          previousLabel={t("previous")}
          nextLabel={t("next")}
        />
        {reachableUnread || truncated ? (
          <p
            data-testid="repositories-reachable-note"
            className="px-4 pb-3 text-xs text-dim"
          >
            {reachableUnread ? t("reachableUnread") : t("truncated")}
          </p>
        ) : null}
        <div className="border-t border-border px-4 py-3.5">
          <p className={note}>{t.rich("note", { code })}</p>
        </div>
      </Panel>
    </div>
  );
}

function Row({
  org,
  ws,
  row,
  issues,
  onIssuesChanged,
  onOpen,
  onAddOxagen,
}: {
  org: string;
  ws: string;
  row: RepositoryRow;
  issues: Load<{ collected: string[] }>;
  onIssuesChanged: (message: string) => void;
  onOpen: (fullName: string) => void;
  onAddOxagen: (fullName: string | null) => void;
}) {
  const t = useTranslations("repositories.repos");
  const state = treeState(row.tree);
  const ready = row.tree?.kind === "ready" ? row.tree.value : null;
  const open = () => {
    onOpen(row.fullName);
  };
  // The whole row opens the dialog to a pointer, as the mockup's rows do; the
  // repository's name is the button a keyboard and a screen reader reach.
  // The row itself takes no role, because it holds Add Oxagen, and a button
  // inside a button is announced as neither.
  return (
    <tr
      data-testid={`repository-row-${row.fullName}`}
      data-role={row.role}
      onClick={open}
      className="cursor-pointer transition-colors hover:bg-hl"
    >
      <td className={cell}>
        <span className="flex min-w-0 items-center gap-2">
          <FolderSimpleIcon
            aria-hidden="true"
            className="size-3.5 flex-none text-dim"
          />
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={t("open", { repository: row.fullName })}
            data-testid={`repository-open-${row.fullName}`}
            data-touch-target=""
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
            className={`${mono} min-w-0 text-left font-semibold text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 md:truncate`}
          >
            {row.fullName}
          </button>
        </span>
        {row.visibility === null ? null : (
          <span className="mt-0.5 block text-sm text-dim md:truncate">
            {t(`visibility.${row.visibility}`)}
          </span>
        )}
        {row.connectionLive ? null : (
          <span
            data-testid={`repository-retired-${row.fullName}`}
            className="mt-1 block text-xs text-error-ink md:truncate"
          >
            {t("retired")}
          </span>
        )}
      </td>
      <td className={cell}>
        <RoleBadge role={row.role} />
      </td>
      <td className={cell}>
        <span className={mono}>{row.productionBranch}</span>
        {ready?.head ? (
          <span className={`${mono} block text-sm text-dim md:truncate`}>
            {ready.head.slice(0, 7)}
          </span>
        ) : null}
      </td>
      <td className={cell}>
        <TreeBadge state={state} testId={`repository-tree-${row.fullName}`} />
        {ready !== null && ready.oxagen.present ? (
          <span
            className={`${mono} mt-0.5 block text-sm text-dim md:truncate`}
          >
            {t("tree.files", { count: ready.oxagen.files.length })}
          </span>
        ) : null}
      </td>
      <td className={cell}>
        <IssuesSwitch
          org={org}
          ws={ws}
          row={row}
          issues={issues}
          onChanged={onIssuesChanged}
        />
      </td>
      <td className={`${cell} text-xs text-muted-foreground`}>
        {row.events === null ? (
          t("none")
        ) : (
          <>
            {t(`events.${row.events}`)}
            <span
              data-state="not-recorded"
              data-gap={REPOSITORY_GAPS.lifecycle}
              className="block text-sm text-dim md:truncate"
            >
              {t("deliveries")}
            </span>
          </>
        )}
      </td>
      <td
        className={`${cell} text-right text-xs text-dim`}
        data-state={row.role === "available" ? undefined : "not-recorded"}
      >
        {row.role === "available" ? t("none") : t("notRecorded")}
      </td>
      <td className={cell}>
        {/* The main repository holds the workspace's steering. A steering
            repo keeps its records at its root, and an older main moves to one
            through the steering repo setup, so neither takes Add Oxagen
            (#5082). */}
        {state === "governed" ? (
          <span className="text-sm text-dim">{t("nothingWaiting")}</span>
        ) : row.role === "main" ||
          (state !== "absent" && state !== "unknown") ? null : (
          <button
            type="button"
            data-testid={`repository-add-${row.fullName}`}
            aria-haspopup="dialog"
            onClick={(event) => {
              event.stopPropagation();
              onAddOxagen(row.fullName);
            }}
            className={buttonSmall}
          >
            {t("addOxagenShort")}
          </button>
        )}
      </td>
    </tr>
  );
}
