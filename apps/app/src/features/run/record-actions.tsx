"use client";
// The two writes on a sealed run's record: generate its name and summary
// (`summarize_run`), and queue a signed evidence bundle (`export_run`).
//
// Both queue work and neither changes the record on the spot, so each says it
// was queued and offers to re-read the run rather than claiming a result it
// cannot see yet. Summarize is offered on a sealed run with no summary, and
// again once one exists, because a run can be re-read after its bodies change
// hands; the label says which of the two it is. Each is drawn disabled, with
// the reason, for a viewer whose org role its handler would refuse. Re-reading
// the run refreshes the route the person is on, so their tab stays put.
//
// An export is the one write whose result this dialog can follow: once
// `export_run` answers an id, the dialog reads it back (`get_run_export`) on a
// bounded schedule until the bundle is ready or the job failed, and then
// offers the download and the command that verifies it offline.
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useState,
} from "react";
import type { ActionResult } from "@/server/kernel";
import type { OrgRole } from "@/server/viewer";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { RunExportDownloadLink, useNavigate } from "@/ui/navigation";
import { parseRunExportDownloadUrl } from "@/shared/run-export-download-url";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  exportRun,
  readRunExport,
  type RunExportStatus,
  summarizeRun,
} from "./actions";

/** The first read waits this long after `export_run` answers; later ones back off. */
export const EXPORT_POLL_FIRST_MS = 2_000;
/** Each wait is this much longer than the one before it, up to the ceiling. */
export const EXPORT_POLL_BACKOFF = 1.5;
const EXPORT_POLL_MAX_MS = 10_000;
/** After this much waiting the dialog stops reading and offers "Check again". */
export const EXPORT_POLL_BUDGET_MS = 120_000;

/** A byte count in the largest decimal unit that keeps it at 1 or more. */
function sizeParts(bytes: number): {
  value: number;
  unit: "byte" | "kilobyte" | "megabyte" | "gigabyte";
} {
  if (bytes < 1_000) return { value: bytes, unit: "byte" };
  if (bytes < 1_000_000) return { value: bytes / 1_000, unit: "kilobyte" };
  if (bytes < 1_000_000_000) {
    return { value: bytes / 1_000_000, unit: "megabyte" };
  }
  return { value: bytes / 1_000_000_000, unit: "gigabyte" };
}

/**
 * A digest shown shortened, with a button that copies all of it.
 *
 * `navigator.clipboard` is absent over plain HTTP and refused by a browser
 * whose permission is denied, so the copy is attempted and its outcome is
 * announced either way. The full digest stays in the element's title and in
 * the copy, and the button never claims a copy that failed.
 */
function CopyDigest({ digest }: { digest: string }) {
  const t = useTranslations("run.record.export");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const short = `${digest.slice(0, "sha256:".length + 12)}…`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(digest);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <code
        data-testid="export-digest"
        title={digest}
        className={`${mono} rounded-md bg-muted px-2 py-1 text-xs`}
      >
        {short}
      </code>
      <button
        type="button"
        className={`${buttonSecondary} h-8 px-2 text-xs`}
        onClick={() => void copy()}
      >
        {state === "copied" ? t("copied") : t("copy")}
      </button>
      {state === "failed" ? (
        <span className="text-xs text-muted-foreground">{t("copyFailed")}</span>
      ) : null}
    </span>
  );
}

/** The bundle once it is built: the link, its size, its digest, and how to verify it. */
function ReadyExport({ status }: { status: RunExportStatus }) {
  const t = useTranslations("run.record.export");
  const format = useFormatter();
  const target =
    status.download === null
      ? null
      : parseRunExportDownloadUrl(status.download.url);
  const size =
    status.bundleBytes === null ? null : sizeParts(status.bundleBytes);
  const command = `oxagen verify ${status.runId}-${status.exportId}.zip`;
  return (
    <div data-testid="export-ready" className="flex flex-col gap-3">
      <p>{t("ready")}</p>
      {target === null ? null : (
        <RunExportDownloadLink
          to={target}
          data-testid="export-download"
          className={`${buttonSecondary} self-start`}
        >
          {t("download")}
        </RunExportDownloadLink>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="text-muted-foreground">{t("size")}</dt>
        <dd data-testid="export-size">
          {size === null
            ? t("sizeUnknown")
            : format.number(size.value, {
                style: "unit",
                unit: size.unit,
                unitDisplay: "short",
                maximumFractionDigits: 1,
              })}
        </dd>
        {status.bundleDigest === null ? null : (
          <>
            <dt className="text-muted-foreground">{t("digest")}</dt>
            <dd>
              <CopyDigest digest={status.bundleDigest} />
            </dd>
          </>
        )}
        {status.download === null ? null : (
          <>
            <dt className="text-muted-foreground">{t("expires")}</dt>
            <dd>
              {format.dateTime(new Date(status.download.expiresAt), {
                timeStyle: "short",
              })}
            </dd>
          </>
        )}
      </dl>
      <p className="text-xs text-muted-foreground">{t("expiresHint")}</p>
      <p className="text-xs font-medium">{t("verify")}</p>
      <code
        data-testid="export-verify-command"
        className={`${mono} break-all rounded-md bg-muted px-2 py-1 text-xs`}
      >
        {command}
      </code>
    </div>
  );
}

type ReadRefusal = Extract<ActionResult<RunExportStatus>, { ok: false }>;

/**
 * Where one export stands, read back on a bounded schedule.
 *
 * The first read waits `EXPORT_POLL_FIRST_MS`, and each later wait is longer,
 * up to a ceiling. Reading stops when the bundle is ready or the job failed,
 * because every read mints a fresh download token, and it stops after
 * `EXPORT_POLL_BUDGET_MS` of waiting, when "Check again" takes over. A refused
 * read stops too: another attempt on its own would get the same answer. The
 * timer is cleared when the dialog closes or the component unmounts, and a
 * read that lands after that is dropped.
 *
 * "Check again" starts a new round that reads at once, so a ready export
 * mints a fresh link on demand after the old one expires.
 */
function ExportStatus({
  org,
  ws,
  exportId,
}: {
  org: string;
  ws: string;
  exportId: string;
}) {
  const t = useTranslations("run.record.export");
  const [status, setStatus] = useState<RunExportStatus | null>(null);
  const [refusal, setRefusal] = useState<ReadRefusal | null>(null);
  const [stalled, setStalled] = useState(false);
  const [reading, setReading] = useState(false);
  /** Bumped by "Check again"; each value is one bounded round of reads. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let waited = 0;
    let wait = EXPORT_POLL_FIRST_MS;

    // Nothing here sets state before a timer fires or a read answers, so a
    // round starts on a timer even when "Check again" asks for a read now.
    function after(delay: number) {
      timer = setTimeout(() => {
        timer = null;
        void read();
      }, delay);
    }

    async function read(): Promise<void> {
      setReading(true);
      let result: ActionResult<RunExportStatus>;
      try {
        result = await readRunExport(org, ws, exportId);
      } catch {
        result = { ok: false, reason: "unavailable", code: "read_failed" };
      }
      if (!live) return;
      setReading(false);
      if (!result.ok) {
        setRefusal(result);
        setStalled(true);
        return;
      }
      setRefusal(null);
      setStatus(result.value);
      const pending =
        result.value.status === "queued" || result.value.status === "building";
      if (!pending) return;
      if (waited + wait > EXPORT_POLL_BUDGET_MS) {
        setStalled(true);
        return;
      }
      waited += wait;
      after(wait);
      wait = Math.min(wait * EXPORT_POLL_BACKOFF, EXPORT_POLL_MAX_MS);
    }

    if (round === 0) {
      waited = EXPORT_POLL_FIRST_MS;
      after(EXPORT_POLL_FIRST_MS);
      wait = EXPORT_POLL_FIRST_MS * EXPORT_POLL_BACKOFF;
    } else {
      after(0);
    }
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [org, ws, exportId, round]);

  function refusalText(failure: ReadRefusal): string {
    if (failure.reason === "not_found") return t("readFailure.notFound");
    if (failure.reason === "denied") return t("readFailure.denied");
    const code =
      failure.reason === "pending_approval" ? failure.reason : failure.code;
    return t("readFailure.other", { code });
  }

  let body: ReactNode;
  if (refusal !== null) {
    body = (
      <FormAlert testId="export-read-failure">{refusalText(refusal)}</FormAlert>
    );
  } else if (status === null) {
    body = <p data-testid="export-progress">{t("checking")}</p>;
  } else if (status.status === "ready") {
    body = <ReadyExport status={status} />;
  } else if (status.status === "failed") {
    body = (
      <FormAlert testId="export-failed">
        {status.error === null
          ? t("failedUnrecorded")
          : t("failed", { error: status.error })}
      </FormAlert>
    );
  } else {
    body = (
      <p data-testid="export-progress" data-status={status.status}>
        {t(`status.${status.status}`)}
      </p>
    );
  }

  const pending =
    refusal === null &&
    (status === null ||
      status.status === "queued" ||
      status.status === "building");
  return (
    <div data-testid="export-status" className="flex flex-col gap-3">
      {body}
      {stalled && pending ? (
        <p data-testid="export-stalled">{t("stalled")}</p>
      ) : null}
      {stalled || status?.status === "ready" ? (
        <button
          type="button"
          data-testid="export-check-again"
          className={`${buttonSecondary} self-start`}
          disabled={reading}
          onClick={() => {
            setStalled(false);
            setRound((n) => n + 1);
          }}
        >
          {t("checkAgain")}
        </button>
      ) : null}
    </div>
  );
}

function RecordDialog<O>({
  action,
  label,
  runId,
  write,
  receipt,
  follow,
}: {
  action: "summarize" | "resummarize" | "export";
  /** The button's words; `summarize` and `resummarize` differ only here. */
  label: string;
  runId: string;
  write: () => Promise<ActionResult<O>>;
  /** The id the queued job answered with, printed so a person can chase it. */
  receipt: (value: O) => string;
  /** What to show under the receipt while the queued work is followed. */
  follow?: (receipt: string) => ReactNode;
}) {
  const t = useTranslations("run.record");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const key = action === "resummarize" ? "summarize" : action;

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setQueued(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write();
      if (result.ok) setQueued(receipt(result.value));
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={`run-${action}`}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t(`${key}.title`, { run: runId })}
        testId={`run-${action}-dialog`}
      >
        {queued === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t(`${key}.body`)}</p>
            {failure === null ? null : (
              <FormAlert testId={`run-${action}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t(`${key}.confirm`)}
              pendingLabel={t(`${key}.pending`)}
            />
          </form>
        ) : (
          <div role="status" className="flex flex-col gap-3 text-sm">
            <p>{t(`${key}.queued`)}</p>
            <code
              data-testid="queued-receipt"
              className={`${mono} break-all rounded-md bg-muted px-2 py-1 text-xs`}
            >
              {queued}
            </code>
            {follow === undefined ? null : follow(queued)}
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => {
                openChange(false);
                navigate.refresh();
              }}
            >
              {t("reread")}
            </button>
          </div>
        )}
      </SheetDialog>
    </>
  );
}

export function RecordActions({
  org,
  ws,
  runId,
  sealed,
  hasSummary,
  summarizable,
  orgRole,
}: {
  org: string;
  ws: string;
  runId: string;
  /** Both writes need a sealed record: a live run is refused by both handlers. */
  sealed: boolean;
  hasSummary: boolean;
  /**
   * `canSummarize` from the row: `summarize_run` refuses a `digest_only`
   * recording, because there are no bodies for a model to read. The contract
   * answers it, so the button and the handler read one rule (#3285).
   */
  summarizable: boolean;
  /**
   * The viewer's organization role, which both handlers assert on:
   * `summarize_run` admits an Owner, Admin or Member and `export_run` an Owner
   * or Admin. A viewer a handler would refuse sees that button disabled with
   * the reason, not a button that ends in `org_role_required`.
   */
  orgRole: OrgRole;
}) {
  const t = useTranslations("run.record");
  if (!sealed) return null;
  const canExport = orgRole === "owner" || orgRole === "admin";
  const hasRole = canExport || orgRole === "member";
  const canSummarize = hasRole && summarizable;
  const summarizeAction = hasSummary ? "resummarize" : "summarize";
  return (
    <div className="flex flex-col items-start gap-2 lg:items-end">
      <div className="flex flex-wrap gap-2">
        {canSummarize ? (
          <RecordDialog
            action={summarizeAction}
            label={t(`${summarizeAction}.open`)}
            runId={runId}
            write={() => summarizeRun(org, ws, runId)}
            receipt={(value) => value.runId}
          />
        ) : (
          <button
            type="button"
            disabled
            data-testid={`run-${summarizeAction}`}
            className={buttonSecondary}
          >
            {t(`${summarizeAction}.open`)}
          </button>
        )}
        {canExport ? (
          <RecordDialog
            action="export"
            label={t("export.open")}
            runId={runId}
            write={() => exportRun(org, ws, runId)}
            receipt={(value) => value.exportId}
            follow={(exportId) => (
              <ExportStatus org={org} ws={ws} exportId={exportId} />
            )}
          />
        ) : (
          <button
            type="button"
            disabled
            data-testid="run-export"
            className={buttonSecondary}
          >
            {t("export.open")}
          </button>
        )}
      </div>
      {canSummarize ? null : (
        <p
          data-testid={hasRole ? "summarize-no-bodies" : "summarize-no-role"}
          className="max-w-prose text-xs text-muted-foreground lg:text-right"
        >
          {hasRole ? t("summarize.needsBodies") : t("summarize.needsRole")}
        </p>
      )}
      {canExport ? null : (
        <p
          data-testid="export-no-role"
          className="max-w-prose text-xs text-muted-foreground lg:text-right"
        >
          {t("export.needsRole")}
        </p>
      )}
    </div>
  );
}
