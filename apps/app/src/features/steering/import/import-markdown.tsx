"use client";
// Import Markdown on the Steering head, and the dialog it opens
// (memory-collection spec, Bulk import; the mockup's md-import.js and
// mockups/pages/md-import.md). The dialog takes a folder of Markdown files at
// once. A person chooses a target for each file, parse_markdown_import splits
// each file into statements with a kind and a force, the person checks every
// statement in one grid, and commit_markdown_import opens one steering PR.
// Nothing steers until that PR merges.
//
// Files are read in this browser. Their text leaves it only when the person
// asks for the review, in parse calls of at most 25 files that each fit one
// server action, and again when the steering PR opens. A second review of the
// same files with the same targets reads nothing again and keeps every
// choice. A new target for a file starts that file's rows again.
//
// The Memories target is drawn closed: it arrives with memory collection
// (#4984). The button is never gold, because the head's gold belongs to the
// page's create action.
import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState, useTransition } from "react";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import { unanswered } from "@/ui/action-failure";
import {
  buttonPrimary,
  buttonSecondary,
  linkText,
  mono,
} from "@/ui/control-styles";
import { PullRequestLink, SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  commitMarkdownImport,
  type ImportCommitted,
  parseMarkdownImport,
} from "./actions";
import {
  TOO_LARGE,
  fileOfField,
  type ImportFailure,
  useImportFailure,
} from "./failure";
import {
  documentsOf,
  type ImportFile,
  type ImportTarget,
  IMPORT_FILES_MAX,
  type PickedFile,
  parseBatches,
  parseKey,
  readPicked,
} from "./files";
import { DropZone, FilesTable } from "./files-step";
import { StatementGrid } from "./review-step";
import {
  commitPayload,
  groupsOf,
  mergeParses,
  type ParseOutput,
  type ParseResult,
  resolveRows,
  type RowEdit,
  rowKey,
  tally,
} from "./rows";

type Picked = { folder: string | null; files: ImportFile[]; ignored: number };
type PickProblem = "none" | "tooMany" | "unreadable";
type Failed = { failure: ImportFailure; file: string | null };
type Step = "files" | "review" | "done";

/** Edits on rows of other files: a file given a new target starts its rows again. */
function withoutFile(
  edits: ReadonlyMap<string, RowEdit>,
  file: string,
): Map<string, RowEdit> {
  const prefix = `${file}\u0000`;
  return new Map([...edits].filter(([key]) => !key.startsWith(prefix)));
}

function ImportDialog({
  org,
  ws,
  open,
  onOpenChange,
}: {
  org: string;
  ws: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("steering.import");
  const sentenceOf = useImportFailure();
  const [picked, setPicked] = useState<Picked | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<PickProblem | null>(null);
  const [step, setStep] = useState<Step>("files");
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [parsed, setParsed] = useState<{
    key: string;
    result: ParseResult;
  } | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, RowEdit>>(
    () => new Map(),
  );
  const [failed, setFailed] = useState<Failed | null>(null);
  const [committed, setCommitted] = useState<ImportCommitted | null>(null);
  const [committing, startCommit] = useTransition();

  const files = picked?.files ?? [];
  const documents = useMemo(
    () => documentsOf(picked?.files ?? []),
    [picked],
  );
  const rows = useMemo(
    () => (parsed === null ? [] : resolveRows(parsed.result.records, edits)),
    [parsed, edits],
  );
  const counts = useMemo(
    () => tally(rows, parsed?.result.policies ?? []),
    [rows, parsed],
  );
  const busy = reading || progress !== null || committing;

  const take = (list: PickedFile[]) => {
    setReading(true);
    setProblem(null);
    readPicked(list).then(
      (read) => {
        setReading(false);
        if (!read.ok) {
          setProblem(read.reason);
          return;
        }
        setPicked(read);
        setParsed(null);
        setEdits(new Map());
        setFailed(null);
        setStep("files");
      },
      () => {
        setReading(false);
        setProblem("unreadable");
      },
    );
  };

  const changeTarget = (path: string, target: ImportTarget) => {
    setPicked((current) =>
      current === null
        ? current
        : {
            ...current,
            files: current.files.map((f) =>
              f.path === path ? { ...f, target } : f,
            ),
          },
    );
    setEdits((current) => withoutFile(current, path));
  };

  const review = async () => {
    const key = parseKey(documents);
    if (parsed?.key === key) {
      setFailed(null);
      setStep("review");
      return;
    }
    const batches = parseBatches(documents);
    const outputs: ParseOutput[] = [];
    let done = 0;
    setFailed(null);
    setProgress({ done, total: documents.length });
    for (const batch of batches) {
      const result = await parseMarkdownImport(org, ws, batch).catch(() =>
        unanswered("action_failed"),
      );
      if (!result.ok) {
        setProgress(null);
        setFailed({
          failure: result,
          file:
            result.reason === "invalid"
              ? fileOfField(
                  result.field,
                  batch.map((d) => d.filename),
                )
              : null,
        });
        return;
      }
      outputs.push(result.value);
      done += batch.length;
      setProgress({ done, total: documents.length });
    }
    setProgress(null);
    setParsed({ key, result: mergeParses(outputs) });
    setStep("review");
  };

  const commit = () => {
    if (parsed === null) return;
    const payload = commitPayload(rows, parsed.result.policies);
    if (payload === null) {
      setFailed({ failure: TOO_LARGE, file: null });
      return;
    }
    setFailed(null);
    startCommit(async () => {
      const result = await commitMarkdownImport(org, ws, payload).catch(() =>
        unanswered("action_failed"),
      );
      if (!result.ok) {
        setFailed({ failure: result, file: null });
        return;
      }
      setCommitted(result.value);
      setStep("done");
    });
  };

  const onEdit = (index: number, edit: RowEdit) => {
    const record = parsed?.result.records[index];
    if (record === undefined) return;
    setEdits((current) => new Map(current).set(rowKey(record), edit));
  };

  const failure =
    failed === null ? null : (
      <div
        role="alert"
        data-testid="import-failure"
        data-reason={failed.failure.reason}
        className="flex flex-col gap-1 text-[13px] text-error-ink"
      >
        <p>{sentenceOf(failed.failure, failed.file)}</p>
        {failed.failure.reason === "exhausted" ? (
          <SafeLink to={routes.billing(org)} className={linkText}>
            {t("failure.billing")}
          </SafeLink>
        ) : null}
      </div>
    );

  const prFiles = counts.records + counts.policies;
  const max = parsed?.result.max ?? 0;
  const tooMany = max > 0 && prFiles > max;
  const out = files.filter((f) => f.target === "skip" || f.locked).length;
  const prUrl =
    committed === null ? null : parsePullRequestUrl(committed.url);

  let body: ReactNode;
  let footer: ReactNode = null;
  let footerNote: ReactNode = undefined;
  if (step === "done" && committed !== null) {
    body = (
      <div
        role="status"
        data-testid="import-done"
        className="flex flex-col gap-2 text-[13px]"
      >
        <p>
          {t("done.opened", {
            number: committed.number,
            branch: committed.branch,
          })}
        </p>
        <p className="text-muted-foreground">
          {t("done.counts", {
            records: committed.records,
            policies: committed.policies,
          })}
        </p>
        {prUrl === null ? (
          <p className={`${mono} text-muted-foreground`}>{committed.url}</p>
        ) : (
          <PullRequestLink
            to={prUrl}
            className={linkText}
            data-testid="import-pr-link"
          >
            {t("done.link", { number: committed.number })}
          </PullRequestLink>
        )}
      </div>
    );
  } else if (step === "review" && parsed !== null) {
    const groups = groupsOf(parsed.result, rows);
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted-foreground">{t("grid.intro")}</p>
        {counts.tokens > 0 ? (
          <p
            className="text-[12.5px] text-muted-foreground"
            data-testid="import-tokens"
          >
            {t("grid.tokens", { count: counts.tokens })}
          </p>
        ) : null}
        {groups.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t("grid.empty")}</p>
        ) : (
          <StatementGrid groups={groups} rows={rows} onEdit={onEdit} />
        )}
        {tooMany ? (
          <p
            role="alert"
            data-testid="import-too-many"
            className="text-[13px] text-error-ink"
          >
            {t("grid.tooMany", {
              count: prFiles,
              max,
              over: prFiles - max,
            })}
          </p>
        ) : null}
        {failure}
      </div>
    );
    footerNote = (
      <span data-testid="import-summary">
        {t("grid.summary", {
          records: counts.records,
          policies: counts.policies,
        })}
        {counts.out > 0 ? ` ${t("grid.out", { count: counts.out })}` : null}
        {counts.open > 0 ? ` ${t("grid.open", { count: counts.open })}` : null}
      </span>
    );
    footer = (
      <>
        <button
          type="button"
          data-touch-target=""
          className={buttonSecondary}
          disabled={committing}
          onClick={() => {
            setFailed(null);
            setStep("files");
          }}
        >
          {t("back")}
        </button>
        <button
          type="button"
          data-touch-target=""
          data-testid="import-commit"
          className={buttonPrimary}
          disabled={committing || counts.open > 0 || prFiles === 0 || tooMany}
          onClick={commit}
        >
          {committing ? t("commitPending") : t("commit")}
        </button>
      </>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-muted-foreground">{t("intro")}</p>
        <DropZone
          disabled={busy}
          onPicked={take}
          onUnreadable={() => {
            setProblem("unreadable");
          }}
        />
        {problem === null ? null : (
          <p
            role="alert"
            data-testid="import-pick-problem"
            className="text-[13px] text-error-ink"
          >
            {problem === "none"
              ? t("drop.none")
              : problem === "tooMany"
                ? t("drop.tooMany", { max: IMPORT_FILES_MAX })
                : t("drop.unreadable")}
          </p>
        )}
        {reading ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            {t("drop.reading")}
          </p>
        ) : null}
        {picked === null ? null : (
          <>
            {picked.ignored > 0 ? (
              <p className="text-[12.5px] text-muted-foreground">
                {t("drop.ignored", { count: picked.ignored })}
              </p>
            ) : null}
            <FilesTable
              files={picked.files}
              parsed={parsed?.result ?? null}
              disabled={busy}
              onTarget={changeTarget}
            />
          </>
        )}
        {progress === null ? null : (
          <p
            role="status"
            data-testid="import-progress"
            className="text-[13px] text-muted-foreground"
          >
            {t("parsing", { done: progress.done, total: progress.total })}
          </p>
        )}
        {failure}
      </div>
    );
    footerNote =
      picked === null ? undefined : (
        <span data-testid="import-file-count">
          {picked.folder === null
            ? t("files.count", { count: files.length })
            : t("files.from", { count: files.length, folder: picked.folder })}
          {out > 0 ? ` ${t("files.out", { count: out })}` : null}
        </span>
      );
    footer = (
      <button
        type="button"
        data-touch-target=""
        data-testid="import-review"
        className={buttonPrimary}
        disabled={busy || documents.length === 0}
        onClick={() => {
          void review();
        }}
      >
        {progress === null ? t("review") : t("reviewPending")}
      </button>
    );
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      wide="xl"
      testId="import-dialog"
      closeLabel={step === "done" ? t("close") : t("cancel")}
      headerClose={step !== "done"}
      dismissible={!committing}
      footer={footer}
      footerNote={footerNote}
    >
      {body}
    </SheetDialog>
  );
}

export function ImportMarkdown({ org, ws }: { org: string; ws: string }) {
  const t = useTranslations("steering.import");
  const [open, setOpen] = useState(false);
  // Each opening starts a fresh import: the key mounts a new dialog state.
  const [opening, setOpening] = useState(0);
  return (
    <>
      <button
        type="button"
        data-testid="import-markdown"
        className={buttonSecondary}
        onClick={() => {
          setOpening((n) => n + 1);
          setOpen(true);
        }}
      >
        <UploadSimpleIcon aria-hidden="true" className="size-3.5" />
        {t("button")}
      </button>
      <ImportDialog
        key={opening}
        org={org}
        ws={ws}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
