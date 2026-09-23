"use client";
// The Changes tab (mockup `chgTab()`; MC spec §10.2): every pull request
// Oxagen has open or merged on this workspace's repositories, and the
// automatic proposers behind them.
//
// Today every row is a context record's Context PR, read through
// `list_proposals`: the other kinds the design names (Oxagen init, skill,
// agent, tool, configuration) have no list read yet (#3241), and the tab says
// so rather than drawing rows it would have to invent. Selecting a row opens
// that pull request on this tab (`changes/<id>`), where its checks, what merge
// will do, and Merge and Close live.
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import type {
  RepositoryChange,
  RepositoryChanges,
} from "@/data/contracts/repository";
import { Badge, type BadgeTone } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import {
  ListBar,
  type ListFilter,
  ListPager,
  useList,
} from "@/ui/list-controls";
import { cell, headCell } from "@/ui/table";
import { useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { code, type Load, note, Panel, PanelBody } from "./parts";

type Status = RepositoryChange["status"];

export const STATUS_TONE: Record<Status, BadgeTone> = {
  pr_open: "quiet",
  checks_running: "approval",
  checks_passed: "allowed",
  checks_failed: "failed",
  merged: "allowed",
  rejected: "quiet",
};

/** Who opened a change, as a word the filter and the cell share. */
export function openerKind(source: string): "person" | "other" {
  return source.startsWith("user:") ? "person" : "other";
}

/**
 * The CI light (mockup `ciLight`): blinking blue while a job runs, a red ✕
 * once one failed, static green when all passed, static grey while queued.
 * State is never the colour alone: the light is aria-hidden and the count and
 * the state badge beside it say the same thing in words.
 */
export function CiLight({ status }: { status: Status }) {
  if (status === "checks_failed")
    return (
      <span
        aria-hidden="true"
        data-ci="failed"
        className="font-bold text-error-ink"
      >
        ✕
      </span>
    );
  const tone =
    status === "checks_running"
      ? "bg-info animate-pulse motion-reduce:animate-none"
      : status === "checks_passed" || status === "merged"
        ? "bg-success"
        : "bg-dim/50";
  const ci =
    status === "checks_running"
      ? "running"
      : status === "checks_passed" || status === "merged"
        ? "passed"
        : "queued";
  return (
    <span
      aria-hidden="true"
      data-ci={ci}
      className={`inline-block size-2.5 rounded-full ${tone}`}
    />
  );
}

export function Changes({
  changes,
  onOpen,
}: {
  changes: Load<RepositoryChanges>;
  onOpen: (proposalId: string) => void;
}) {
  const t = useTranslations("repositories.changes");
  const failureText = useRepositoriesFailure();
  return (
    <div data-testid="changes" className="flex flex-col gap-3.5">
      <Panel
        id="changes-panel"
        testId="changes-panel"
        title={t("title")}
        subtitle={t("subtitle")}
      >
        {changes.kind === "loading" ? (
          <p
            role="status"
            data-testid="changes-loading"
            className="px-4 py-3.5 text-[13px] text-muted-foreground"
          >
            {t("loading")}
          </p>
        ) : changes.kind === "failed" ? (
          <div className="px-4 py-3.5">
            <FormAlert testId="changes-failure">
              {failureText(changes.failure)}
            </FormAlert>
          </div>
        ) : (
          <ChangeTable rows={changes.value.changes} onOpen={onOpen} />
        )}
        <div className="flex flex-col gap-2.5 border-t border-border px-4 py-3.5">
          <p
            data-testid="changes-other-kinds"
            data-state="not-recorded"
            data-gap={REPOSITORY_GAPS.lifecycle}
            className="text-xs text-dim"
          >
            {t("otherKinds")}
          </p>
          <p className={note}>{t("note")}</p>
        </div>
      </Panel>
      <Panel id="changes-auto" testId="changes-auto" title={t("autoTitle")}>
        <PanelBody>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-2.5 text-[13px] leading-relaxed max-sm:grid-cols-1">
            {(["promoter", "reconciler", "person"] as const).map((who) => (
              <div key={who} className="contents" data-opener={who}>
                <dt className="text-dim">{t(`auto.${who}.name`)}</dt>
                <dd className="text-foreground">
                  {t.rich(`auto.${who}.what`, { code })}
                </dd>
              </div>
            ))}
          </dl>
          <p className={`mt-3 ${note}`}>{t("drift")}</p>
        </PanelBody>
      </Panel>
    </div>
  );
}

function ChangeTable({
  rows,
  onOpen,
}: {
  rows: readonly RepositoryChange[];
  onOpen: (proposalId: string) => void;
}) {
  const t = useTranslations("repositories.changes");
  const repos = useTranslations("repositories.repos");
  const filters: ListFilter<RepositoryChange>[] = [
    {
      key: "state",
      label: t("filters.state"),
      options: (Object.keys(STATUS_TONE) as Status[]).map((status) => ({
        value: status,
        label: t(`states.${status}`),
      })),
      get: (row) => row.status,
    },
    {
      key: "kind",
      label: t("filters.kind"),
      options: [{ value: "context_record", label: t("kinds.context_record") }],
      get: (row) => row.kind,
    },
    {
      key: "openedBy",
      label: t("filters.openedBy"),
      options: [
        { value: "person", label: t("openedBy.person") },
        { value: "other", label: t("openedBy.other") },
      ],
      get: (row) => openerKind(row.openedBy),
    },
  ];
  const list = useList(rows, {
    text: (row) =>
      `${row.lineage} ${row.statement} ${row.pullRequest.repository} ${row.pullRequest.branch} ${row.openedBy}`,
    filters,
  });
  return (
    <>
      <ListBar
        list={list}
        searchLabel={t("search")}
        filters={filters}
        allLabel={(column) => repos("all", { column })}
        rowsLabel={repos("rows")}
      />
      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label={t("label")}
          data-testid="changes-table"
          className="w-full min-w-[760px] border-collapse text-[13px]"
        >
          <thead>
            <tr className="border-b border-border">
              {(
                [
                  "change",
                  "kind",
                  "pullRequest",
                  "openedBy",
                  "state",
                  "checks",
                  "opened",
                ] as const
              ).map((column) => (
                <th
                  key={column}
                  scope="col"
                  className={`${headCell} text-left`}
                >
                  {t(`columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.shown.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  data-testid="changes-empty"
                  className={`${cell} text-dim`}
                >
                  {rows.length === 0 ? t("empty") : repos("nothing")}
                </td>
              </tr>
            ) : (
              list.shown.map((row) => (
                <ChangeRow key={row.proposalId} row={row} onOpen={onOpen} />
              ))
            )}
          </tbody>
        </table>
      </div>
      <ListPager
        list={list}
        range={(from, to, total) => repos("range", { from, to, total })}
        previousLabel={repos("previous")}
        nextLabel={repos("next")}
      />
    </>
  );
}

function ChangeRow({
  row,
  onOpen,
}: {
  row: RepositoryChange;
  onOpen: (proposalId: string) => void;
}) {
  const t = useTranslations("repositories.changes");
  const format = useFormatter();
  const open = () => {
    onOpen(row.proposalId);
  };
  const keyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  const person = openerKind(row.openedBy) === "person";
  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={t("open", { change: row.lineage })}
      data-testid={`change-row-${row.proposalId}`}
      data-status={row.status}
      onClick={open}
      onKeyDown={keyDown}
      className="cursor-pointer transition-colors hover:bg-hl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <td className={cell}>
        <span className="flex items-center gap-2">
          <FileText
            aria-hidden="true"
            className="size-3.5 flex-none text-dim"
          />
          <b className="break-all font-semibold text-foreground">
            {row.lineage}
          </b>
        </span>
        <span className={`${mono} mt-0.5 block text-[11px] text-dim`}>
          {row.pullRequest.branch}
        </span>
      </td>
      <td className={cell}>
        <Badge tone="quiet" dot={false}>
          {t(`kinds.${row.kind}`)}
        </Badge>
      </td>
      <td className={`${cell} ${mono} whitespace-nowrap`}>
        {row.pullRequest.repository}#{row.pullRequest.number}
      </td>
      <td className={cell}>
        {person ? (
          <span className="text-foreground">{t("openedBy.person")}</span>
        ) : (
          <span className={`${mono} break-all text-foreground`}>
            {row.openedBy}
          </span>
        )}
      </td>
      <td className={cell}>
        <Badge
          tone={STATUS_TONE[row.status]}
          data-testid={`change-state-${row.proposalId}`}
        >
          {t(`states.${row.status}`)}
        </Badge>
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <span className="inline-flex items-center gap-2">
          <CiLight status={row.status} />
          <span className={`${mono} text-[11.5px] text-muted-foreground`}>
            {row.checks === null
              ? t("ci.queued")
              : t("ci.count", {
                  done: row.checks.passed,
                  total: row.checks.total,
                })}
          </span>
        </span>
      </td>
      <td className={`${cell} whitespace-nowrap text-muted-foreground`}>
        <time dateTime={row.openedAt}>
          {format.dateTime(new Date(row.openedAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </time>
      </td>
    </tr>
  );
}
