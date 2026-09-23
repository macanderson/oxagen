"use client";
// The Repositories tab (mockup `repoTab()`; MC spec §10.1, §11.2): every
// repository this workspace binds, main first, and every repository the
// installation reaches that it does not, as `not linked`. Role is the
// workspace's word, not GitHub's. Every row opens the repository dialog by
// click, Enter or Space.
//
// Bound rows are local facts (`list_repositories` makes no GitHub call), so
// the table draws while GitHub is down. The `.oxagen/` column is a live read
// per bound repository (`get_repository_tree`); a repository that is not
// linked has no binding to read through, so its tree reads as not read. The
// delivery counters and the code graph have no store yet and say so.
import { FolderGit2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import {
  ListBar,
  type ListFilter,
  ListPager,
  useList,
} from "@/ui/list-controls";
import { cell, headCell } from "@/ui/table";
import { REPOSITORY_GAPS } from "./gaps";
import {
  buttonSmall,
  code,
  note,
  Panel,
} from "./parts";
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

export function RoleBadge({ role }: { role: RepositoryRow["role"] }) {
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
export function ungoverned(rows: readonly RepositoryRow[]): RepositoryRow[] {
  return rows.filter(
    (row) => row.role === "linked" && treeState(row.tree) === "absent",
  );
}

export function RepositoriesTab({
  rows,
  reachableUnread,
  truncated,
  onOpen,
  onAddOxagen,
}: {
  rows: RepositoryRow[];
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
          <Badge tone="approval">{t("bannerBadge", { count: bare.length })}</Badge>
          <div className="min-w-0 flex-1 text-[13px] text-muted-foreground">
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
          rowsLabel={t("rows")}
        />
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-label={t("label")}
            data-testid="repositories-table"
            className="w-full min-w-[720px] border-collapse text-[13px]"
          >
            <thead>
              <tr className="border-b border-border">
                {(
                  [
                    "repository",
                    "role",
                    "productionBranch",
                    "oxagen",
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
                  <td colSpan={7} className={`${cell} text-dim`}>
                    {t("nothing")}
                  </td>
                </tr>
              ) : (
                list.shown.map((row) => (
                  <Row
                    key={row.fullName}
                    row={row}
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
  row,
  onOpen,
  onAddOxagen,
}: {
  row: RepositoryRow;
  onOpen: (fullName: string) => void;
  onAddOxagen: (fullName: string | null) => void;
}) {
  const t = useTranslations("repositories.repos");
  const state = treeState(row.tree);
  const ready = row.tree?.kind === "ready" ? row.tree.value : null;
  const open = () => {
    onOpen(row.fullName);
  };
  const keyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={t("open", { repository: row.fullName })}
      data-testid={`repository-row-${row.fullName}`}
      data-role={row.role}
      onClick={open}
      onKeyDown={keyDown}
      className="cursor-pointer transition-colors hover:bg-hl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <td className={cell}>
        <span className="flex items-center gap-2">
          <FolderGit2 aria-hidden="true" className="size-3.5 flex-none text-dim" />
          <b className={`${mono} break-all font-semibold text-foreground`}>
            {row.fullName}
          </b>
        </span>
        {row.visibility === null ? null : (
          <span className="mt-0.5 block text-[11px] text-dim">
            {t(`visibility.${row.visibility}`)}
          </span>
        )}
        {row.connectionLive ? null : (
          <span
            data-testid={`repository-retired-${row.fullName}`}
            className="mt-1 block text-xs text-error-ink"
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
          <span className={`${mono} block text-[11px] text-dim`}>
            {ready.head.slice(0, 7)}
          </span>
        ) : null}
      </td>
      <td className={cell}>
        <TreeBadge state={state} testId={`repository-tree-${row.fullName}`} />
        {ready !== null && ready.oxagen.present ? (
          <span className={`${mono} mt-0.5 block text-[11px] text-dim`}>
            {t("tree.files", { count: ready.oxagen.files.length })}
          </span>
        ) : null}
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
              className="block text-[11px] text-dim"
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
        {state === "governed" ? (
          <span className="text-[11.5px] text-dim">{t("nothingWaiting")}</span>
        ) : state !== "absent" && state !== "unknown" ? null : (
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
