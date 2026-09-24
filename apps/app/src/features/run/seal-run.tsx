"use client";
// Seal run (ADR-169): end a wrapped run the control plane still reads as
// live, and stop its agent.
//
// A run whose agent finished without sending `agent_stop` reads as live until
// the twelve-hour idle close. This seals it now through `seal_run`, which also
// queues a kill for the agent on its host when the host can collect a
// command. The seal is final, so the button carries the danger style and
// opens a dialog that says so before anything is written.
//
// The dialog says in advance whether the kill can be sent, from the row's
// `commandBlock`, and afterwards what the control plane actually did, from its
// answer. A kill that was queued is not a kill that happened: the host carries
// it out on its next check.
//
// A viewer `seal_run` would refuse (neither an organization Owner or Admin
// nor the workspace Owner) sees the button disabled with the reason, as
// Export draws its own.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { CommandBlock } from "@/data/contracts/runs";
import type { OrgRole, WsRole } from "@/server/viewer";
import { canSealRun } from "@/shared/run-command-roles";
import {
  COMMAND_BLOCK_COPY,
  UNANSWERED,
  useActionFailure,
} from "@/ui/command-failure";
import {
  buttonDanger,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type SealedRun, sealRun } from "./actions";

export function SealRunAction({
  org,
  ws,
  runId,
  commandBlock,
  orgRole,
  wsRole,
}: {
  org: string;
  ws: string;
  runId: string;
  /** Why a command cannot reach the run, from the row; null when the kill can be sent. */
  commandBlock: CommandBlock | null;
  orgRole: OrgRole;
  wsRole: WsRole;
}) {
  const t = useTranslations("run.seal");
  const reasonId = useId();
  if (!canSealRun(orgRole, wsRole)) {
    // The reason is said on the disabled button: on hover, and to assistive
    // technology through the description it points to.
    return (
      <>
        <button
          type="button"
          disabled
          title={t("roleReason")}
          aria-describedby={reasonId}
          data-testid="run-seal"
          className={buttonDanger}
        >
          {t("open")}
        </button>
        <span id={reasonId} data-testid="run-seal-refused" className="sr-only">
          {t("roleReason")}
        </span>
      </>
    );
  }
  return (
    <SealDialog
      runId={runId}
      commandBlock={commandBlock}
      write={(reason) => sealRun(org, ws, runId, reason)}
    />
  );
}

function SealDialog({
  runId,
  commandBlock,
  write,
}: {
  runId: string;
  commandBlock: CommandBlock | null;
  write: (reason: string) => ReturnType<typeof sealRun>;
}) {
  const t = useTranslations("run.seal");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [sealed, setSealed] = useState<SealedRun | null>(null);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setSealed(null);
      setReason("");
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write(reason);
      if (result.ok) setSealed(result.value);
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
        data-testid="run-seal"
        className={buttonDanger}
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
        testId="run-seal-dialog"
      >
        {sealed === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <p data-testid="run-seal-kill" className="text-sm">
              {commandBlock === null
                ? t("killBody")
                : t(`killBlocked.${COMMAND_BLOCK_COPY[commandBlock]}`)}
            </p>
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t("reasonLabel")}
            </label>
            <textarea
              id={fieldId}
              name="reason"
              rows={2}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className={`${inputBase} resize-y`}
            />
            <p className="text-xs text-muted-foreground">{t("reasonHelp")}</p>
            {failure === null ? null : (
              <FormAlert testId="run-seal-failure">{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        ) : (
          <div role="status" className="flex flex-col gap-3 text-sm">
            <p>{t("sealed")}</p>
            {sealed.kill.status === "queued" ? (
              <p data-testid="run-seal-kill-queued">
                {t("killQueued")}{" "}
                <span className={`${mono} break-all text-xs`}>
                  {sealed.kill.commandId}
                </span>
              </p>
            ) : (
              <p
                data-testid="run-seal-kill-not-sent"
                className="text-muted-foreground"
              >
                {t(`killNotSent.${COMMAND_BLOCK_COPY[sealed.kill.reason]}`)}
              </p>
            )}
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
