"use client";
// Fork replay and Bisect (spec §8.4), the two writes that read one recording
// to start another piece of work.
//
// Fork mints an attempt: frames 0 to N replay from the recording, the next
// model call runs live, and a tool result after N is served from the cassette
// when its input digest matches. Oxagen mints the attempt and records where it
// branched; the harness that admitted the run is what resumes it (ADR-043), so
// the dialog answers with the attempt and does not claim an agent is running.
//
// Bisect reads two recordings and answers the first frame at which they
// diverge. It is a read, and it changes nothing, so its dialog reports a
// position rather than a receipt.
//
// Neither is offered on a recording that cannot carry it. Fork needs a ledger
// run graded `fork` and every body before the branch point retained, which the
// handler checks and refuses with `conflict`; the button is drawn disabled,
// with the reason, wherever the row already says the recording is weaker, so a
// person is not sent to a refusal they could have read here.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { RunRow } from "@/data/contracts/runs";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { bisectRuns, forkRun } from "./actions";
import { UNANSWERED, useActionFailure } from "./command-failure";
import { RunSelector } from "./run-selector";

type Divergence = {
  divergentSeq: string | null;
  keyA: string | null;
  keyB: string | null;
  aligned: number;
};

function ForkDialog({
  org,
  ws,
  runId,
}: {
  org: string;
  ws: string;
  runId: string;
}) {
  const t = useTranslations("run.replay.fork");
  const failureText = useActionFailure();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [seq, setSeq] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setAttempt(null);
      setSeq("");
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await forkRun(org, ws, runId, seq.trim());
      if (result.ok) setAttempt(result.value.attemptId);
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
        data-testid="run-fork"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { run: runId })}
        testId="run-fork-dialog"
      >
        {attempt === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t("seqLabel")}
            </label>
            <input
              id={fieldId}
              name="fromSeq"
              inputMode="numeric"
              required
              value={seq}
              onChange={(event) => {
                setSeq(event.target.value);
              }}
              className={inputBase}
            />
            <p className="text-xs text-muted-foreground">{t("seqHelp")}</p>
            {failure === null ? null : (
              <FormAlert testId="run-fork-failure">{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        ) : (
          <div role="status" className="flex flex-col gap-3 text-sm">
            <p>{t("minted")}</p>
            <code
              data-testid="fork-attempt"
              className={`${mono} break-all rounded-md bg-muted px-2 py-1 text-xs`}
            >
              {attempt}
            </code>
          </div>
        )}
      </SheetDialog>
    </>
  );
}

function BisectDialog({
  org,
  ws,
  runId,
}: {
  org: string;
  ws: string;
  runId: string;
}) {
  const t = useTranslations("run.replay.bisect");
  const failureText = useActionFailure();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [other, setOther] = useState<RunRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<Divergence | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setResult(null);
      setOther(null);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || other === null) return;
    setPending(true);
    setFailure(null);
    try {
      const answer = await bisectRuns(org, ws, runId, other.id);
      if (answer.ok) setResult(answer.value);
      else setFailure(failureText(answer));
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
        data-testid="run-bisect"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { run: runId })}
        wide
        testId="run-bisect-dialog"
      >
        {result === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <RunSelector
              org={org}
              ws={ws}
              runId={runId}
              selected={other}
              onSelect={setOther}
            />
            {failure === null ? null : (
              <FormAlert testId="run-bisect-failure">{failure}</FormAlert>
            )}
            <button
              type="submit"
              disabled={other === null || pending}
              className={`${buttonPrimary} w-full`}
            >
              {pending ? t("pending") : t("confirm")}
            </button>
          </form>
        ) : (
          <div role="status" className="flex flex-col gap-2 text-sm">
            {result.divergentSeq === null ? (
              <p data-testid="bisect-same">
                {t("same", { aligned: result.aligned })}
              </p>
            ) : (
              <>
                <p data-testid="bisect-diverged">
                  {t("diverged", {
                    seq: result.divergentSeq,
                    aligned: result.aligned,
                  })}
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{t("keyA")}</dt>
                  <dd className={`${mono} break-all`}>
                    {result.keyA ?? t("noFrame")}
                  </dd>
                  <dt className="text-muted-foreground">{t("keyB")}</dt>
                  <dd className={`${mono} break-all`}>
                    {result.keyB ?? t("noFrame")}
                  </dd>
                </dl>
              </>
            )}
          </div>
        )}
      </SheetDialog>
    </>
  );
}

export function ReplayActions({
  org,
  ws,
  run,
}: {
  org: string;
  ws: string;
  run: RunRow;
}) {
  const t = useTranslations("run.replay");
  // `fork_run` refuses a wrapped session by name and a recording graded below
  // `fork`; both are on the row, so the reason is said here rather than in a
  // refusal. Bisect reads receipts alone, so it works at every grade.
  const forkable =
    run.source === "ledger" &&
    (run.replayGrade === "fork" || run.replayGrade === "retry");
  const reason =
    run.source !== "ledger"
      ? t("forkNeedsLedger")
      : run.replayGrade === null
        ? t("forkNoGrade")
        : t("forkNeedsGrade", { grade: run.replayGrade });
  return (
    <div className="flex flex-col items-start gap-2 lg:items-end">
      <div className="flex flex-wrap gap-2">
        {forkable ? (
          <ForkDialog org={org} ws={ws} runId={run.id} />
        ) : (
          <button
            type="button"
            disabled
            data-testid="run-fork"
            className={buttonSecondary}
          >
            {t("fork.open")}
          </button>
        )}
        <BisectDialog org={org} ws={ws} runId={run.id} />
      </div>
      {forkable ? null : (
        <p
          data-testid="fork-refused"
          className="max-w-prose text-xs text-muted-foreground lg:text-right"
        >
          {reason}
        </p>
      )}
    </div>
  );
}
