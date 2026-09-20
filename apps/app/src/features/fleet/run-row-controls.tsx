"use client";
// The controls on a run's row in Fleet (spec §7.4): pause, resume and cancel,
// each behind the same confirming dialog the run's own page uses and over the
// same `dispatch_command` contract. Fleet is where a person watches every run
// at once, so stopping one should not cost a navigation first.
//
// Steer is not here. The contract requires a payload on it, and the text and
// the delivery mode it carries need the room the run page's dialog gives them.
//
// The row gates on the same four facts the run page does, in the same order,
// and every one of them is already on the row (`data/contracts/runs.ts`):
//
//   not live         → no controls; there is nothing running to reach
//   observe tier     → the reason; Oxagen was never in the path of its calls
//   ledger source    → the reason; no run token Oxagen can revoke (WL-61)
//   role refused     → the reason; `dispatch_command` would answer denied
//
// Where the run page draws the buttons disabled beside the reason, a row
// draws the reason alone. A table of live ledger runs would otherwise carry
// three dead buttons per row, and the sentence is the part that tells a
// person why.
//
// The queued marker is optimistic: it appears the moment the form is
// submitted and rolls back if the control plane refused, or if it queued the
// command for nobody. It never says the run paused, only that the pause was
// taken, because `dispatch_command` queues and the run's own status is what
// says the agent obeyed.
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { useTranslations } from "next-intl";
import {
  type SyntheticEvent,
  useId,
  useOptimistic,
  useState,
  useTransition,
} from "react";
import { acceptsCommands, type RunRow } from "@/data/contracts/runs";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import { buttonSecondary, inputBase, linkText } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { ROW_COMMANDS, type RowCommand } from "@/shared/row-commands";
import { dispatchRunCommand } from "./actions";

/** Why a live run draws no controls, in the words the run page already uses. */
function NoRowControls({
  reason,
  testId,
}: {
  reason: "observeReason" | "ledgerReason" | "roleReason";
  testId: string;
}) {
  const t = useTranslations("run.commands");
  const controls = useTranslations("fleet.runs.controls");
  return (
    <details
      data-testid={testId}
      className="max-w-[18rem] text-xs text-muted-foreground"
    >
      <summary className="cursor-pointer whitespace-nowrap">
        {controls("unavailable")}
      </summary>
      <p className="pt-2">{t(reason)}</p>
    </details>
  );
}

function RowCommands({
  org,
  ws,
  runId,
}: {
  org: string;
  ws: string;
  runId: string;
}) {
  const t = useTranslations("fleet.runs.controls");
  const command = useTranslations("run.commands");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const fieldId = useId();
  const [open, setOpen] = useState<RowCommand | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  // What the control plane took, and what the row claims it took while the
  // write is in flight. `useOptimistic` resets to `taken` when the transition
  // ends, so a refusal rolls the marker back with no branch of its own.
  const [taken, setTaken] = useState<RowCommand | null>(null);
  const [pending, startTransition] = useTransition();
  const [claimed, claim] = useOptimistic(
    taken,
    (_current, next: RowCommand) => next,
  );

  function openChange(next: boolean) {
    if (!next) {
      setOpen(null);
      setReason("");
      setFailure(null);
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const sending = open;
    if (sending === null || pending) return;
    setFailure(null);
    startTransition(async () => {
      claim(sending);
      try {
        const result = await dispatchRunCommand(
          org,
          ws,
          runId,
          sending,
          reason,
        );
        if (!result.ok) {
          setFailure(failureText(result));
        } else if (result.value.commandIds.length === 0) {
          // The control plane wrote no row, so nothing was queued and the
          // marker must go back rather than stand as a receipt.
          setFailure(command("noRecipient"));
        } else {
          setTaken(sending);
          openChange(false);
        }
      } catch {
        setFailure(failureText(UNANSWERED));
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div
        role="group"
        aria-label={t("group", { run: runId })}
        className="flex flex-wrap gap-1.5"
      >
        {ROW_COMMANDS.map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`row-${name}`}
            aria-label={t("action", {
              command: command(`${name}.open`),
              run: runId,
            })}
            className={`${buttonSecondary} px-2 py-1 text-xs`}
            onClick={() => {
              setFailure(null);
              setOpen(name);
            }}
          >
            {command(`${name}.open`)}
          </button>
        ))}
      </div>
      {claimed === null ? null : (
        <p
          data-testid="row-command-state"
          aria-live="polite"
          className="max-w-[18rem] text-xs text-muted-foreground"
        >
          {pending
            ? t("sending", { command: t(`verbs.${claimed}`) })
            : t("queued", { command: t(`verbs.${claimed}`) })}
        </p>
      )}
      {claimed === null || pending ? null : (
        <button
          type="button"
          data-testid="row-reread"
          className={`${linkText} text-xs`}
          onClick={() => {
            navigate.refresh();
          }}
        >
          {t("reread")}
        </button>
      )}
      <SheetDialog
        open={open !== null}
        onOpenChange={openChange}
        title={
          open === null
            ? t("group", { run: runId })
            : command(`${open}.title`, { run: runId })
        }
        testId="row-command-dialog"
      >
        {open === null ? null : (
          <form
            onSubmit={submit}
            className="flex flex-col gap-3"
            data-testid={`row-${open}-form`}
          >
            <p className="text-sm text-muted-foreground">
              {command(`${open}.body`)}
            </p>
            <label htmlFor={fieldId} className="text-sm font-medium">
              {command("reasonLabel")}
            </label>
            <textarea
              id={fieldId}
              name="reason"
              rows={2}
              maxLength={COMMAND_REASON_MAX}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className={`${inputBase} resize-y`}
            />
            <p className="text-xs text-muted-foreground">
              {command("reasonHelp")}
            </p>
            {failure === null ? null : (
              <FormAlert testId="row-command-failure">{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={command(`${open}.confirm`)}
              pendingLabel={command(`${open}.pending`)}
            />
          </form>
        )}
      </SheetDialog>
    </div>
  );
}

export function RunRowControls({
  org,
  ws,
  runId,
  status,
  source,
  enforcementTier,
  canCommand,
}: {
  org: string;
  ws: string;
  runId: string;
  status: RunRow["status"];
  source: RunRow["source"];
  /** Where the run was observed from; an `observe` tier has no connection point. */
  enforcementTier: RunRow["enforcementTier"];
  /** Whether `dispatch_command` admits this viewer (`@/shared/run-command-roles`). */
  canCommand: boolean;
}) {
  if (status !== "live") return null;
  if (!acceptsCommands(enforcementTier)) {
    return (
      <NoRowControls reason="observeReason" testId="row-observe-no-control" />
    );
  }
  if (source === "ledger") {
    return (
      <NoRowControls reason="ledgerReason" testId="row-ledger-no-control" />
    );
  }
  if (!canCommand) {
    return <NoRowControls reason="roleReason" testId="row-role-no-control" />;
  }
  return <RowCommands org={org} ws={ws} runId={runId} />;
}
