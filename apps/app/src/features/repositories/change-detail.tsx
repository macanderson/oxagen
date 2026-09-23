"use client";
// One Context PR on the Changes tab (mockup `oxprDetail()`; MC spec §10.2):
// the route `repositories/changes/<id>`, the address the close comment links
// to. It reads `get_context_pr` on demand and shows the pull request's kind,
// branch and base, who opened it and why, the file it carries, every check
// with its own result, and what merge will do.
//
// The lifecycle's truths, each enforced here and again by the handler:
//   - A failed check stops the run where it stopped. The failing row says why,
//     the checks behind it read queued, and merge is disabled.
//   - Merge is enabled only when every check reported and none failed, and the
//     pull request is not merged. The click handler refuses otherwise, so a
//     disabled button invoked anyway is a no-op; `merge_context_pr` re-reads
//     the governance mode and the head at merge time and refuses on its own.
//   - Close previews the comment Oxagen would post. `dismiss_proposal` closes
//     the pull request and records that text as the reason; posting it on
//     GitHub has no write yet (#3241), and the dialog says so.
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { RepositoryChange } from "@/data/contracts/repository";
import type { ContextPr } from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, headCell } from "@/ui/table";
import {
  closeRepositoryChange,
  mergeRepositoryChange,
  readRepositoryChange,
} from "./actions";
import { CiLight, openerKind, STATUS_TONE } from "./changes";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { buttonDanger, code, kv, type Load, note, SectionLabel } from "./parts";

type Check = ContextPr["checks"][number];

/** The signed-in person the close comment names. */
export type Closer = { name: string; email: string };

/** Every check reported, none failed, and nothing merged yet. */
export function canMerge(pr: ContextPr): boolean {
  return (
    pr.status === "checks_passed" &&
    pr.merged === null &&
    pr.checks.length > 0 &&
    pr.checks.every((check) => check.status === "passed")
  );
}

/** The first failed check, which stopped the run. */
function stopper(checks: readonly Check[]): Check | null {
  return checks.find((check) => check.status === "failed") ?? null;
}

const RESULT_TONE = {
  passed: "allowed",
  failed: "failed",
  running: "approval",
  pending: "quiet",
} as const;

export function ChangeDetail({
  org,
  ws,
  proposalId,
  row,
  closer,
  onBack,
  onMergeable,
  onChanged,
}: {
  org: string;
  ws: string;
  proposalId: string;
  /** The list's row for this change, when the list holds it. */
  row: RepositoryChange | null;
  closer: Closer;
  onBack: () => void;
  /** Merge holds the screen's one gold only when it can run. */
  onMergeable: (mergeable: boolean) => void;
  /** A merge or a close settled; the list re-reads. */
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.change");
  const states = useTranslations("repositories.changes.states");
  const failureText = useRepositoriesFailure();
  const [version, setVersion] = useState(0);
  const [read, setRead] = useState<Load<ContextPr>>({ kind: "loading" });
  const [merging, setMerging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const live = { current: true };
    setRead({ kind: "loading" });
    const load = async () => {
      let result;
      try {
        result = await readRepositoryChange(org, ws, proposalId);
      } catch {
        result = UNANSWERED;
      }
      if (!live.current) return;
      setRead(
        result.ok
          ? { kind: "ready", value: result.value }
          : { kind: "failed", failure: result },
      );
    };
    void load();
    return () => {
      live.current = false;
    };
  }, [org, ws, proposalId, version]);

  const pr = read.kind === "ready" ? read.value : null;
  const mergeable = pr !== null && canMerge(pr);
  useEffect(() => {
    onMergeable(mergeable);
    return () => {
      onMergeable(false);
    };
  }, [mergeable, onMergeable]);

  async function merge() {
    // A disabled Merge invoked anyway does nothing.
    if (pr === null || !canMerge(pr) || merging) return;
    setMerging(true);
    setFailure(null);
    try {
      const result = await mergeRepositoryChange(org, ws, proposalId);
      if (result.ok) {
        setDone(t("mergedDone", { commit: result.value.commit.slice(0, 7) }));
        setVersion((n) => n + 1);
        onChanged();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setMerging(false);
    }
  }

  // A proposal with no pull request yet is not a change on GitHub; it reads
  // as open here, and Merge stays disabled until its checks report.
  const recorded = pr?.status ?? row?.status ?? "pr_open";
  const status: RepositoryChange["status"] =
    recorded === "proposed" ? "pr_open" : recorded;
  const passed = pr?.checks.filter((check) => check.status === "passed").length;
  const total = pr?.checks.length;
  const title = row?.lineage ?? pr?.lineage ?? proposalId;
  const failed = pr === null ? null : stopper(pr.checks);

  return (
    <section
      aria-labelledby="change-title"
      data-testid="change-detail"
      data-status={status}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-hl px-4 py-3">
        <button
          type="button"
          data-testid="change-back"
          data-touch-target=""
          className={`${buttonSecondary} min-h-7 px-2.5 py-1 text-xs`}
          onClick={onBack}
        >
          {t("back")}
        </button>
        <h2
          id="change-title"
          className="min-w-0 flex-1 break-all text-[13.5px] font-semibold text-foreground"
        >
          {title}
        </h2>
        <span className="inline-flex items-center gap-2">
          <CiLight status={status} />
          {passed === undefined || total === undefined ? null : (
            <span className={`${mono} text-[11.5px] text-muted-foreground`}>
              {passed} / {total}
            </span>
          )}
          <Badge tone={STATUS_TONE[status]} data-testid="change-state">
            {states(status)}
          </Badge>
        </span>
      </div>

      {read.kind === "loading" ? (
        <p
          role="status"
          data-testid="change-loading"
          className="px-4 py-3.5 text-[13px] text-muted-foreground"
        >
          {t("loading")}
        </p>
      ) : read.kind === "failed" ? (
        <div className="px-4 py-3.5">
          <FormAlert testId="change-failure">
            {failureText(read.failure)}
          </FormAlert>
        </div>
      ) : (
        <Loaded
          pr={read.value}
          row={row}
          failed={failed}
          mergeable={mergeable}
          merging={merging}
          failure={failure}
          done={done}
          onMerge={() => {
            void merge();
          }}
          onClose={() => {
            setClosing(true);
          }}
        />
      )}

      {pr?.pr === null || pr === null ? null : (
        <ClosePullRequestDialog
          org={org}
          ws={ws}
          proposalId={proposalId}
          pullRequest={`${pr.pr.repository}#${String(pr.pr.number)}`}
          closer={closer}
          open={closing}
          onClose={() => {
            setClosing(false);
          }}
          onClosed={() => {
            setClosing(false);
            setDone(t("closed"));
            setVersion((n) => n + 1);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function Loaded({
  pr,
  row,
  failed,
  mergeable,
  merging,
  failure,
  done,
  onMerge,
  onClose,
}: {
  pr: ContextPr;
  row: RepositoryChange | null;
  failed: Check | null;
  mergeable: boolean;
  merging: boolean;
  failure: string | null;
  done: string | null;
  onMerge: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("repositories.change");
  const changes = useTranslations("repositories.changes");
  const format = useFormatter();
  const base = pr.pr?.baseRef ?? "";
  const settled = pr.merged !== null || pr.status === "rejected";
  const reported = pr.checks.every(
    (check) => check.status === "passed" || check.status === "failed",
  );
  return (
    <>
      <div className="border-b border-border px-4 py-3.5">
        <dl className={kv}>
          <dt>{t("facts.kind")}</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge tone="quiet" dot={false}>
              {changes("kinds.context_record")}
            </Badge>
            <span className={`${mono} text-[11.5px] text-dim`}>
              {changes("kindPaths.context_record")}
            </span>
          </dd>
          <dt>{t("facts.pullRequest")}</dt>
          <dd className={mono} data-testid="change-pr">
            {pr.pr === null
              ? t("whyNotRecorded")
              : `${pr.pr.repository}#${String(pr.pr.number)}`}
          </dd>
          <dt>{t("facts.branch")}</dt>
          <dd>
            {pr.pr === null
              ? t("whyNotRecorded")
              : t.rich("branchValue", {
                  branch: pr.pr.branch,
                  base: pr.pr.baseRef,
                  code,
                })}
          </dd>
          <dt>{t("facts.openedBy")}</dt>
          <dd>
            {row === null ? (
              <span data-state="not-recorded" className="text-dim">
                {t("whyNotRecorded")}
              </span>
            ) : (
              <>
                {openerKind(row.openedBy) === "person"
                  ? changes("openedBy.person")
                  : row.openedBy}
                <span className="text-dim">
                  {" · "}
                  {format.dateTime(new Date(row.openedAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
              </>
            )}
          </dd>
          <dt>{t("facts.why")}</dt>
          <dd data-testid="change-why">
            {row === null || row.why.trim() === "" ? (
              <span data-state="not-recorded" className="text-dim">
                {t("whyNotRecorded")}
              </span>
            ) : (
              row.why
            )}
          </dd>
        </dl>
      </div>

      <div className="border-b border-border px-4 py-3.5">
        <SectionLabel id="change-files">{t("filesTitle")}</SectionLabel>
        <ul
          aria-labelledby="change-files"
          data-testid="change-files"
          className="text-[12.5px]"
        >
          <li className={`${mono} text-foreground`}>{pr.onMerge.path}</li>
        </ul>
      </div>

      <div className="border-b border-border px-4 py-3.5">
        <SectionLabel id="change-checks">{t("checksTitle")}</SectionLabel>
        <div className="min-w-0 overflow-x-auto rounded-[10px] border border-border">
          <table
            aria-label={t("checksLabel")}
            data-testid="change-checks"
            className="w-full min-w-[520px] border-collapse text-[13px]"
          >
            <thead>
              <tr className="border-b border-border">
                {(["check", "result", "what"] as const).map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className={`${headCell} text-left`}
                  >
                    {t(`checkColumns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pr.checks.map((check) => (
                <tr
                  key={check.name}
                  data-check={check.name}
                  data-result={check.status}
                >
                  <td className={`${cell} ${mono}`}>{check.name}</td>
                  <td className={cell}>
                    <Badge tone={RESULT_TONE[check.status]}>
                      {t(`results.${check.status}`)}
                    </Badge>
                  </td>
                  <td className={`${cell} text-muted-foreground`}>
                    {check.summary.trim() !== ""
                      ? check.summary
                      : failed !== null && check.status === "pending"
                        ? t("didNotRun", { check: failed.name })
                        : t("notReported")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {failed === null ? null : (
          <p
            data-testid="change-stopped"
            className="mt-3 border-l-2 border-error py-0.5 pl-3 text-[12.5px] leading-relaxed text-muted-foreground"
          >
            {t.rich("stopped", {
              check: failed.name,
              summary: failed.summary,
              strong: (chunks) => (
                <b className="font-semibold text-foreground">{chunks}</b>
              ),
            })}
          </p>
        )}
      </div>

      <div className="px-4 py-3.5">
        <SectionLabel id="change-merge">{t("mergeTitle")}</SectionLabel>
        <ol
          aria-labelledby="change-merge"
          data-testid="change-merge-steps"
          className="overflow-hidden rounded-[10px] border border-border text-[13px]"
        >
          {(
            ["squash", "deleteBranch", "reindex", "ledger", "audit"] as const
          ).map((step, index) => (
            <li
              key={step}
              className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0"
            >
              <b className="font-semibold text-foreground">{index + 1}</b>
              <span className="text-muted-foreground">
                {t.rich(`merge.${step}`, {
                  base,
                  current: pr.onMerge.bundleVersion.current,
                  after: pr.onMerge.bundleVersion.afterMerge,
                  code,
                })}
              </span>
            </li>
          ))}
        </ol>
        {failure === null ? null : (
          <div className="mt-3">
            <FormAlert testId="change-merge-failure">{failure}</FormAlert>
          </div>
        )}
        {done === null ? null : (
          <p
            role="status"
            data-testid="change-done"
            className="mt-3 text-[13px] text-foreground"
          >
            {done}
          </p>
        )}
        {pr.merged !== null ? (
          <p data-testid="change-merged" className={`mt-3 ${note}`}>
            {t.rich("merged", { base, code })}
          </p>
        ) : settled ? null : (
          <div className="mt-3.5 flex flex-wrap items-center gap-2.5 max-sm:flex-col max-sm:items-stretch">
            <button
              type="button"
              data-testid="change-merge"
              data-touch-target=""
              disabled={!mergeable || merging}
              aria-disabled={!mergeable || merging}
              className={mergeable ? buttonPrimary : buttonSecondary}
              onClick={onMerge}
            >
              {merging ? t("merging") : t("mergeButton")}
            </button>
            <button
              type="button"
              data-testid="change-close"
              data-touch-target=""
              aria-haspopup="dialog"
              disabled={pr.pr === null}
              className={buttonDanger}
              onClick={onClose}
            >
              {t("closeButton")}
            </button>
            <span data-testid="change-governance" className="text-xs text-dim">
              {!reported || failed !== null
                ? t("waiting")
                : pr.governanceMode === null
                  ? t("governanceUnread")
                  : t("governance", { mode: pr.governanceMode })}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Close a pull request without merging (mockup `DLG_EXT.closepr`): the
 * comment Oxagen posts, previewed. The link is this page's full URL, so a
 * reader on GitHub lands on the Context PR that closed it.
 */
function ClosePullRequestDialog({
  org,
  ws,
  proposalId,
  pullRequest,
  closer,
  open,
  onClose,
  onClosed,
}: {
  org: string;
  ws: string;
  proposalId: string;
  pullRequest: string;
  closer: Closer;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const t = useTranslations("repositories.closepr");
  const failureText = useRepositoriesFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const path = routes.repositories(org, ws, "changes", proposalId);
  const url =
    typeof window === "undefined" ? path : `${window.location.origin}${path}`;
  const closedBy = t("closedBy", {
    name: closer.name,
    email: `<${closer.email}>`,
  });
  const comment = `${closedBy}\n\n---\n\n${t("addedVia")} [${url}](${url})`;

  async function submit() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await closeRepositoryChange(org, ws, proposalId, comment);
      if (result.ok) onClosed();
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFailure(null);
          onClose();
        }
      }}
      title={t("title", { pr: pullRequest })}
      subtitle={t("subtitle")}
      closeLabel={t("cancel")}
      testId="closepr-dialog"
      footer={
        <button
          type="button"
          data-testid="closepr-submit"
          data-touch-target=""
          disabled={pending}
          className="inline-flex min-h-9 items-center justify-center rounded-[9px] border border-error bg-error px-[13px] py-1.5 text-[13px] font-medium text-error-foreground hover:bg-error/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45"
          onClick={() => {
            void submit();
          }}
        >
          {pending ? t("pending") : t("submit")}
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        {failure === null ? null : (
          <FormAlert testId="closepr-failure">{failure}</FormAlert>
        )}
        <p className="text-sm leading-relaxed text-foreground">{t("lead")}</p>
        <div
          data-testid="closepr-comment"
          className="rounded-[10px] border border-border bg-hl px-3.5 py-3 text-[13px] text-foreground"
        >
          <p>{closedBy}</p>
          <hr className="my-2.5 border-border" />
          <p>
            {t("addedVia")}{" "}
            <SafeLink
              to={path}
              data-testid="closepr-link"
              className="break-all text-link underline-offset-2 hover:underline"
            >
              {url}
            </SafeLink>
          </p>
        </div>
        <p
          data-state="not-recorded"
          data-gap={REPOSITORY_GAPS.lifecycle}
          className="text-xs text-dim"
        >
          {t("notPosted")}
        </p>
        <p className={note}>{t("note")}</p>
      </div>
    </SheetDialog>
  );
}
