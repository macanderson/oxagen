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
// handler checks and refuses with `conflict`. It also needs an organization
// Owner, Admin or Member, whatever the viewer's workspace role, which the
// handler refuses with `org_role_required`. The button is drawn disabled, with
// the reason, wherever the row or the viewer's role already answers, so a
// person is not sent to a refusal they could have read here.
//
// Bisect's other run is picked by name from the workspace's runs. The picker
// is freeform, so a run id pasted from elsewhere is still sent as typed.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { RunRow } from "@/data/contracts/runs";
import { chooseRuns } from "@/features/shell/client";
import type { OrgRole } from "@/server/viewer";
import { canForkRun } from "@/shared/run-command-roles";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { RecordPicker } from "@/ui/record-picker";
import { SheetDialog } from "@/ui/sheet-dialog";
import { bisectRuns, forkRun } from "./actions";

type Divergence = {
  divergentSeq: string | null;
  keyA: string | null;
  keyB: string | null;
  aligned: number;
};

/** Where a replay button sits: its words and its test hook, which the header and the Chain tab each name. */
type ActionFace = { label?: string; testId?: string };

function ForkDialog({
  org,
  ws,
  runId,
  label,
  testId = "run-fork",
  fromSeq = "",
}: {
  org: string;
  ws: string;
  runId: string;
  /** The frame the dialog opens on, when the page has one open. */
  fromSeq?: string;
} & ActionFace) {
  const t = useTranslations("run.replay.fork");
  const failureText = useActionFailure();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [seq, setSeq] = useState(fromSeq);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<string | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setAttempt(null);
      setSeq(fromSeq);
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
        data-testid={testId}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label ?? t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { run: runId })}
        testId={`${testId}-dialog`}
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

/** Bisect reads receipts alone, so it is offered at every grade. */
export function BisectDialog({
  org,
  ws,
  runId,
  label,
  testId = "run-bisect",
}: {
  org: string;
  ws: string;
  runId: string;
} & ActionFace) {
  const t = useTranslations("run.replay.bisect");
  const failureText = useActionFailure();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [other, setOther] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<Divergence | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setResult(null);
      setOther("");
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const answer = await bisectRuns(org, ws, runId, other);
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
        data-testid={testId}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label ?? t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title", { run: runId })}
        testId={`${testId}-dialog`}
      >
        {result === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t("otherLabel")}
            </label>
            <RecordPicker
              id={fieldId}
              name="runB"
              required
              freeform
              load={() => chooseRuns(org, ws)}
              value={other}
              onChange={setOther}
              aria-describedby={`${fieldId}-help`}
            />
            <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">
              {t("otherHelp")}
            </p>
            {failure === null ? null : (
              <FormAlert testId="run-bisect-failure">{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
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

/**
 * Fork replay, or the disabled button that says why not. `fork_run` refuses a
 * wrapped session by name, a recording graded below `fork`, and a viewer
 * whose organization role is not Owner, Admin or Member. The first two are on
 * the row and the third is the viewer's, so the reason is said here rather
 * than in a refusal. The recording's reason comes first: a viewer who gains
 * the role still could not fork a recording that cannot carry it.
 */
export function ForkAction({
  org,
  ws,
  run,
  orgRole,
  label,
  testId = "run-fork",
  fromSeq,
}: {
  org: string;
  ws: string;
  run: RunRow;
  /** The viewer's organization role. `fork_run` reads no workspace role. */
  orgRole: OrgRole;
  fromSeq?: string;
} & ActionFace) {
  const t = useTranslations("run.replay");
  const reasonId = useId();
  const recordingAllows =
    run.source === "ledger" &&
    (run.replayGrade === "fork" || run.replayGrade === "retry");
  if (recordingAllows && canForkRun(orgRole))
    return (
      <ForkDialog
        org={org}
        ws={ws}
        runId={run.id}
        label={label}
        testId={testId}
        fromSeq={fromSeq}
      />
    );
  const reason =
    run.source !== "ledger"
      ? t("forkNeedsLedger")
      : run.replayGrade === null
        ? t("forkNoGrade")
        : !recordingAllows
          ? t("forkNeedsGrade", { grade: run.replayGrade })
          : t("forkNeedsRole");
  // The button sits in a row of actions, so a refusal is said on the
  // disabled button itself (on hover, and to assistive tech as its
  // description) rather than as a line under the row.
  const text = label ?? t("fork.open");
  return (
    <>
      <button
        type="button"
        disabled
        title={reason}
        aria-describedby={reasonId}
        data-testid={testId}
        className={buttonSecondary}
      >
        {text}
      </button>
      <span
        id={reasonId}
        data-testid={
          testId === "run-fork" ? "fork-refused" : `${testId}-refused`
        }
        className="sr-only"
      >
        {reason}
      </span>
    </>
  );
}

export function ReplayActions({
  org,
  ws,
  run,
  orgRole,
}: {
  org: string;
  ws: string;
  run: RunRow;
  /** The viewer's organization role, which Fork is gated on. */
  orgRole: OrgRole;
}) {
  // The two buttons sit in the header's action row beside Export.
  return (
    <>
      <ForkAction org={org} ws={ws} run={run} orgRole={orgRole} />
      <BisectDialog org={org} ws={ws} runId={run.id} />
    </>
  );
}
