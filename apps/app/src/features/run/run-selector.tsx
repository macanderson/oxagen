"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { RunStatus, type RunPage, type RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { StatusBadge } from "@/ui/status-badge";
import { RunDiff } from "./run-diff";
import { RunContext } from "./run-context";
import { searchBisectRuns } from "./search-actions";

/** Server search, not filtering a recent slice: older recordings remain findable. */
export function RunSelector({
  org,
  ws,
  runId,
  selected,
  onSelect,
}: {
  org: string;
  ws: string;
  runId: string;
  selected: RunRow | null;
  onSelect: (run: RunRow | null) => void;
}) {
  const t = useTranslations("run.replay.bisect");
  const statuses = useTranslations("ui.runStatus");
  const format = useFormatter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [harness, setHarness] = useState("");
  const [repository, setRepository] = useState("");
  const [status, setStatus] = useState<RunStatus | undefined>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<RunPage>({ runs: [], nextCursor: null });
  const [failure, setFailure] = useState<Exclude<
    Read<RunPage>,
    { ok: true }
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (selected !== null) return;
    // Cleanup invalidates responses from old queries and closed dialogs.
    let current = true;
    const timer = setTimeout(() => {
      void searchBisectRuns(org, ws, runId, {
        cursor,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(harness ? { harness } : {}),
        ...(repository.trim() ? { repository: repository.trim() } : {}),
        ...(status ? { status } : {}),
      })
        .then((answer) => {
          if (!current) return;
          setLoading(false);
          if (!answer.ok) {
            setFailure(answer);
            return;
          }
          setFailure(null);
          setPage((previous) => ({
            runs: (cursor === null
              ? answer.value.runs
              : [...previous.runs, ...answer.value.runs]
            ).filter(
              (run, index, rows) =>
                run.id !== runId &&
                rows.findIndex((row) => row.id === run.id) === index,
            ),
            nextCursor: answer.value.nextCursor,
          }));
        })
        .catch(() => {
          if (!current) return;
          setLoading(false);
          setFailure({
            ok: false,
            reason: "error",
            code: "run_search_unavailable",
            status: 503,
          });
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    org,
    ws,
    runId,
    search,
    harness,
    repository,
    status,
    cursor,
    retry,
    selected,
  ]);

  useEffect(() => {
    if (active >= 0)
      document
        .getElementById(`${id}-option-${page.runs[active]?.id}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, id, page.runs]);

  function reset() {
    onSelect(null);
    setCursor(null);
    setPage({ runs: [], nextCursor: null });
    setActive(-1);
    setLoading(true);
    setFailure(null);
    setExpanded(true);
  }
  function filterChanged() {
    if (selected !== null) setSearch("");
    reset();
  }
  function choose(run: RunRow) {
    onSelect(run);
    setSearch(run.name ?? run.id);
    setExpanded(false);
    setActive(-1);
    setLoading(false);
    input.current?.focus();
  }
  const visible = expanded && selected === null;
  const activeRun = visible ? page.runs[active] : undefined;
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={id} className="text-sm font-medium">
        {t("otherLabel")}
      </label>
      <input
        ref={input}
        id={id}
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? `${id}-results` : undefined}
        aria-describedby={`${id}-help`}
        aria-activedescendant={
          activeRun ? `${id}-option-${activeRun.id}` : undefined
        }
        value={search}
        maxLength={200}
        placeholder={t("searchPlaceholder")}
        className={inputBase}
        onChange={(event) => {
          setSearch(event.target.value);
          reset();
        }}
        onFocus={() => setExpanded(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && visible) {
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setExpanded(true);
            setActive((index) =>
              event.key === "ArrowDown"
                ? Math.min(index + 1, page.runs.length - 1)
                : Math.max(index - 1, 0),
            );
          }
          if (event.key === "Enter" && selected === null) {
            event.preventDefault();
            if (activeRun) choose(activeRun);
          }
        }}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {t("otherHelp")}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs">
          {t("harnessFilter")}
          <select
            className={inputBase}
            value={harness}
            onChange={(event) => {
              setHarness(event.target.value);
              filterChanged();
            }}
          >
            <option value="">{t("allHarnesses")}</option>
            {["claude-code", "codex", "cursor", "stella", "unknown"].map(
              (value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="text-xs">
          {t("statusFilter")}
          <select
            className={inputBase}
            value={status ?? ""}
            onChange={(event) => {
              setStatus(RunStatus.safeParse(event.target.value).data);
              filterChanged();
            }}
          >
            <option value="">{t("allStatuses")}</option>
            {RunStatus.options.map((value) => (
              <option key={value} value={value}>
                {statuses(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          {t("repositoryFilter")}
          <input
            className={inputBase}
            maxLength={500}
            value={repository}
            onChange={(event) => {
              setRepository(event.target.value);
              filterChanged();
            }}
          />
        </label>
      </div>
      {visible ? (
        <>
          <div
            id={`${id}-results`}
            role="listbox"
            aria-label={t("resultsLabel")}
            aria-busy={loading}
            className="max-h-64 overflow-y-auto rounded-md border border-border"
          >
            {page.runs.map((run, index) => (
              <button
                key={run.id}
                id={`${id}-option-${run.id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(run)}
                className="flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left text-sm last:border-0 hover:bg-muted aria-selected:bg-muted"
              >
                <span className="font-medium">
                  {run.name ?? run.taskRef ?? run.repository?.name ?? run.id}
                </span>
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>{run.harness ?? t("unknownHarness")}</span>
                  <StatusBadge status={run.status} />
                  <time dateTime={run.startedAt}>
                    {format.dateTime(new Date(run.startedAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </span>
                <span className="break-all text-xs text-muted-foreground">
                  {[
                    run.repository?.name,
                    run.repository?.branch,
                    run.workingDirectory,
                    run.operatorName,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span
                  className={`${mono} break-all text-xs text-muted-foreground`}
                >
                  {run.id}
                </span>
              </button>
            ))}
          </div>
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("searchLoading")}
            </p>
          ) : failure ? (
            <>
              <FormAlert>
                {failure.reason === "denied"
                  ? t("searchDenied")
                  : failure.reason === "pending_approval"
                    ? t("searchApproval", { request: failure.accessRequestId })
                    : t("searchError")}
              </FormAlert>
              {failure.reason === "error" ? (
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => {
                    setLoading(true);
                    setFailure(null);
                    setRetry((n) => n + 1);
                  }}
                >
                  {t("retrySearch")}
                </button>
              ) : null}
            </>
          ) : page.runs.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("noResults")}
            </p>
          ) : null}
          {page.nextCursor && !loading && !failure ? (
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                setLoading(true);
                setCursor(page.nextCursor);
              }}
            >
              {t("loadMore")}
            </button>
          ) : null}
        </>
      ) : null}
      {selected ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          data-testid="bisect-selection"
        >
          <p className="text-sm font-medium">
            {t("selectedRun", { run: selected.name ?? selected.id })}
          </p>
          <code className={`${mono} break-all text-xs`}>{selected.id}</code>
          <RunContext run={selected} />
          <RunDiff key={selected.id} org={org} ws={ws} runId={selected.id} />
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => {
              setSearch("");
              reset();
              input.current?.focus();
            }}
          >
            {t("changeRun")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
