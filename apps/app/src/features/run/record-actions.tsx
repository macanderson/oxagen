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
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import type { OrgRole } from "@/server/viewer";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { exportRun, summarizeRun } from "./actions";

function RecordDialog<O>({
  action,
  label,
  runId,
  write,
  receipt,
}: {
  action: "summarize" | "resummarize" | "export";
  /** The button's words; `summarize` and `resummarize` differ only here. */
  label: string;
  runId: string;
  write: () => Promise<ActionResult<O>>;
  /** The id the queued job answered with, printed so a person can chase it. */
  receipt: (value: O) => string;
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
