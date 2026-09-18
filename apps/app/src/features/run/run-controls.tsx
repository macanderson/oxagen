"use client";
// The controls on a live run (spec §7.4; mockup `pRun`'s header actions):
// pause, resume, steer and cancel, each behind a confirming dialog that takes
// the reason the model reads.
//
// Each button queues a command; none of them changes the run here. The dialog
// says so, and on success it names the command ids the control plane wrote, so
// a person can tell "Oxagen accepted this" from "the agent has stopped". The
// page then reloads, because the run's own status is what says whether it did.
//
// A sealed or halted run has nothing to reach, so it draws no controls. A
// ledger run draws them disabled: its evidence arrives from an external engine
// that Oxagen holds no revocable run token for, so a queued command would have
// no connection point to travel down (WL-61). A viewer `dispatch_command`
// would refuse — neither an org Owner or Admin nor a workspace Owner or
// Member — sees them disabled with that reason, not a button that ends in
// `org_role_required`.
//
// Re-reading the run refreshes the route the person is on, so the tab, zoom
// and frames page they were using stay put.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { RunRow } from "@/data/contracts/runs";
import type { ActionResult } from "@/server/kernel";
import type { OrgRole, WsRole } from "@/server/viewer";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./command-failure";
import { haltRun, type QueuedCommand, steerRun } from "./actions";

const COMMANDS = ["pause", "resume", "steer", "cancel"] as const;
type Command = (typeof COMMANDS)[number];

function CommandDialog({
  command,
  runId,
  write,
}: {
  command: Command;
  runId: string;
  /** The reason a pause carries, or the text a steer sends. */
  write: (text: string) => Promise<ActionResult<QueuedCommand>>;
}) {
  const t = useTranslations("run.commands");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[] | null>(null);
  const steering = command === "steer";

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setQueued(null);
      setText("");
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write(text);
      if (result.ok) setQueued(result.value.commandIds);
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
        data-testid={`run-${command}`}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t(`${command}.open`)}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t(`${command}.title`, { run: runId })}
        testId={`run-${command}-dialog`}
      >
        {queued === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">
              {t(`${command}.body`)}
            </p>
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t(steering ? "steerLabel" : "reasonLabel")}
            </label>
            <textarea
              id={fieldId}
              name="text"
              rows={steering ? 5 : 2}
              required={steering}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={`${inputBase} resize-y`}
            />
            <p className="text-xs text-muted-foreground">
              {t(steering ? "steerHelp" : "reasonHelp")}
            </p>
            {failure === null ? null : (
              <FormAlert testId={`run-${command}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t(`${command}.confirm`)}
              pendingLabel={t(`${command}.pending`)}
            />
          </form>
        ) : (
          <div role="status" className="flex flex-col gap-3 text-sm">
            <p>{t(`${command}.queued`)}</p>
            {queued.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("noRecipient")}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {queued.map((id) => (
                  <li
                    key={id}
                    data-testid="queued-command"
                    className={`${mono} break-all text-xs`}
                  >
                    {id}
                  </li>
                ))}
              </ul>
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

/** Whether `dispatch_command` admits this viewer: org Owner or Admin, or workspace Owner or Member. */
function canCommand(orgRole: OrgRole, wsRole: WsRole): boolean {
  return (
    orgRole === "owner" ||
    orgRole === "admin" ||
    wsRole === "owner" ||
    wsRole === "member"
  );
}

function DisabledControls({
  reason,
  testId,
}: {
  reason: string;
  testId: string;
}) {
  const t = useTranslations("run.commands");
  return (
    <div className="flex flex-col items-start gap-2 lg:items-end">
      <div className="flex flex-wrap gap-2">
        {COMMANDS.map((command) => (
          <button
            key={command}
            type="button"
            disabled
            data-testid={`run-${command}`}
            className={buttonSecondary}
          >
            {t(`${command}.open`)}
          </button>
        ))}
      </div>
      <p
        data-testid={testId}
        className="max-w-prose text-xs text-muted-foreground lg:text-right"
      >
        {reason}
      </p>
    </div>
  );
}

export function RunControls({
  org,
  ws,
  runId,
  status,
  source,
  orgRole,
  wsRole,
}: {
  org: string;
  ws: string;
  runId: string;
  status: RunRow["status"];
  source: RunRow["source"];
  orgRole: OrgRole;
  wsRole: WsRole;
}) {
  const t = useTranslations("run.commands");
  if (status !== "live") return null;
  if (source === "ledger") {
    return (
      <DisabledControls reason={t("ledgerReason")} testId="ledger-no-control" />
    );
  }
  if (!canCommand(orgRole, wsRole)) {
    return (
      <DisabledControls reason={t("roleReason")} testId="role-no-control" />
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {COMMANDS.map((command) => (
        <CommandDialog
          key={command}
          command={command}
          runId={runId}
          write={(text) =>
            command === "steer"
              ? steerRun(org, ws, runId, text)
              : haltRun(org, ws, runId, command, text)
          }
        />
      ))}
    </div>
  );
}
