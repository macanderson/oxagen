"use client";
// ⌘K's "Pause every live run in this workspace" (#3862): a confirm dialog
// that asks for the reason, sends one `pause_workspace_runs` write through
// the kernel seam (`pauseWorkspaceRunsAction`), and shows the receipt.
//
// The receipt reads the handler's answer as it came back: how many runs
// took the pause, each live run no host could reach with why, and the
// command ids, which the viewer can copy. The skip reasons are the ones a
// run's row shows (`COMMAND_BLOCK_COPY`, ADR-163).
//
// The dialog does not hide itself from a viewer without the role. The shell
// knows the organization role and not the workspace role, so it cannot tell
// a workspace Owner from a Member. The handler decides, and a refusal is
// shown in the handler's words through `useActionFailure`.
//
// On a phone it rises from the bottom edge as a sheet (`SheetDialog`).
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState, useTransition } from "react";
import {
  COMMAND_BLOCK_COPY,
  UNANSWERED,
  useActionFailure,
} from "@/ui/command-failure";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  pauseWorkspaceRunsAction,
  type WorkspacePause,
} from "./pause-workspace-actions";

export function PauseWorkspaceDialog({
  org,
  ws,
  onClose,
}: {
  org: string;
  ws: string;
  onClose: () => void;
}) {
  const t = useTranslations("shell.pauseWorkspace");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<WorkspacePause | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const blocked = reason.trim() === "";

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (blocked) {
      setFailure(t("reasonRequired"));
      return;
    }
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await pauseWorkspaceRunsAction(org, ws, reason);
        if (!result.ok) setFailure(failureText(result));
        else {
          setReceipt(result.value);
          navigate.refresh();
        }
      } catch {
        setFailure(failureText(UNANSWERED));
      }
    });
  }

  // The ids stay on screen and selectable, so a browser that refuses the
  // clipboard loses nothing.
  function copyIds(ids: readonly string[]) {
    // An insecure origin has no clipboard at all.
    if (!("clipboard" in navigator)) return;
    navigator.clipboard.writeText(ids.join("\n")).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  }

  return (
    <SheetDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      testId="pause-workspace-dialog"
      {...(receipt === null
        ? { headerClose: true, closeLabel: t("cancel") }
        : {})}
      footer={
        receipt === null ? (
          <button
            type="submit"
            form={formId}
            data-touch-target=""
            disabled={pending}
            className={buttonPrimary}
          >
            {pending ? t("pending") : t("confirm")}
          </button>
        ) : undefined
      }
    >
      {receipt !== null ? (
        <div
          role="status"
          data-testid="pause-workspace-receipt"
          className="flex flex-col gap-3 text-sm"
        >
          <p data-testid="pause-workspace-queued">
            {t("queued", { count: receipt.queued })}
          </p>
          {receipt.skipped.length === 0 ? null : (
            <div className="flex flex-col gap-1">
              <p>{t("skipped", { count: receipt.skipped.length })}</p>
              <ul
                data-testid="pause-workspace-skipped"
                className="flex flex-col gap-1 text-xs text-muted-foreground"
              >
                {receipt.skipped.map((skip) => (
                  <li key={skip.commandId} data-run={skip.runId}>
                    <span className={mono}>{skip.runId}</span>
                    {` (${skip.agentKey}): `}
                    {t(`skippedReason.${COMMAND_BLOCK_COPY[skip.reason]}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {receipt.commandIds.length === 0 ? null : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{t("commandIds")}</span>
                <button
                  type="button"
                  data-touch-target=""
                  className={`${buttonSecondary} px-2 py-0.5 text-xs`}
                  onClick={() => {
                    copyIds(receipt.commandIds);
                  }}
                >
                  {copied ? t("copied") : t("copy")}
                </button>
              </div>
              <code
                data-testid="pause-workspace-ids"
                className={`${mono} block select-all whitespace-pre-wrap break-all rounded-lg border border-border px-3 py-2 text-xs`}
              >
                {receipt.commandIds.join("\n")}
              </code>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t("recorded")}</p>
        </div>
      ) : (
        <form
          id={formId}
          onSubmit={submit}
          noValidate
          className="flex flex-col gap-4 text-sm"
        >
          <p>{t("body")}</p>
          <p className="text-xs text-muted-foreground">
            {t("skippedNote")} {t("ledger")}
          </p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={reasonId} className="text-xs font-medium">
              {t("reasonLabel")}
            </label>
            <textarea
              id={reasonId}
              rows={3}
              required
              aria-required="true"
              aria-describedby={`${reasonId}-help`}
              maxLength={COMMAND_REASON_MAX}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className={`${inputBase} resize-y max-md:min-h-11 max-md:text-base`}
            />
            <p
              id={`${reasonId}-help`}
              className="text-xs text-muted-foreground"
            >
              {t("reasonHelp")}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">{t("roles")}</p>
          {failure === null ? null : (
            <FormAlert testId="pause-workspace-failure">{failure}</FormAlert>
          )}
        </form>
      )}
    </SheetDialog>
  );
}
