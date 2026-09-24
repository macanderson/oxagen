"use client";
// The controls on a live run (spec §7.4; mockup `pRun`'s header actions):
// pause, resume, steer and cancel, each behind a confirming dialog that takes
// the reason the model reads.
//
// Steer also takes a delivery mode (spec §7.3): whether the text rides the
// next model call, cuts the step in flight short to land sooner, or waits for
// the end of the turn. The mode is a ceiling. Each connection point carries
// the strongest one it can at or below it and the command records both, so
// the form says when the text can arrive, not when it will.
//
// Each button queues a command; none of them changes the run here. The dialog
// says so, and on success it names the command ids the control plane wrote, so
// a person can tell "Oxagen accepted this" from "the agent has stopped". The
// page then reloads, because the run's own status is what says whether it did.
//
// A sealed or halted run has nothing to reach, so it draws no controls. A
// ledger run can pause, resume, or cancel evidence ingress. Steering stays
// disabled until the producer carries it. An `observe`-tier run draws them
// disabled for the same reason from the other direction: the session only
// records what an agent did, and Oxagen was never in the path, so there is
// nothing at the other end of a command. A viewer `dispatch_command`
// would refuse (neither an org Owner or Admin nor a workspace Owner or
// Member) sees them disabled with that reason, not a button that ends in
// `org_role_required`.
//
// Re-reading the run refreshes the route the person is on, so the tab, zoom
// and frames page they were using stay put.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import {
  acceptsCommands,
  DeliveryMode,
  type RunRow,
} from "@/data/contracts/runs";
import type { ActionResult } from "@/server/kernel";
import type { OrgRole, WsRole } from "@/server/viewer";
import { canCommandRun } from "@/shared/run-command-roles";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { haltRun, type QueuedCommand, steerRun } from "./actions";

const COMMANDS = ["pause", "resume", "steer", "cancel"] as const;
type Command = (typeof COMMANDS)[number];

/**
 * The delivery modes `dispatch_command`'s `payload.requestedMode` accepts, in
 * the order the form offers them, each mapped to the key its copy sits under.
 * A `Record` over the contract's own union, so a fourth mode added there fails
 * this build instead of quietly going unoffered.
 */
const DELIVERY_COPY = {
  next_step: "nextStep",
  interrupt: "interrupt",
  turn_boundary: "turnBoundary",
} as const satisfies Record<DeliveryMode, string>;
const DELIVERY_MODES = DeliveryMode.options;
const DELIVERY_DEFAULT: DeliveryMode = "next_step";

/**
 * When the agent sees the steering text. One radio per mode with the line
 * that says when it arrives, because the choice is only meaningful next to
 * what each one costs the run in flight.
 */
function DeliveryPicker({
  value,
  onChange,
}: {
  value: DeliveryMode;
  onChange: (mode: DeliveryMode) => void;
}) {
  const t = useTranslations("run.commands.delivery");
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-1 text-sm font-medium">{t("legend")}</legend>
      {DELIVERY_MODES.map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="requestedMode"
            value={mode}
            checked={value === mode}
            data-testid={`steer-mode-${mode}`}
            onChange={() => {
              onChange(mode);
            }}
            className="mt-1 flex-none accent-brand"
          />
          <span className="flex flex-col">
            <span className="font-medium">
              {t(`${DELIVERY_COPY[mode]}.label`)}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(`${DELIVERY_COPY[mode]}.help`)}
            </span>
          </span>
        </label>
      ))}
      <p className="text-xs text-muted-foreground">{t("ceiling")}</p>
    </fieldset>
  );
}

function CommandDialog({
  command,
  runId,
  write,
  ledgerControl = false,
}: {
  command: Command;
  runId: string;
  ledgerControl?: boolean;
  /**
   * The reason a pause carries, or the text a steer sends with the delivery
   * mode picked for it. A halt ignores the mode: the contract refuses a
   * payload on pause, resume and cancel.
   */
  write: (
    text: string,
    mode: DeliveryMode,
  ) => Promise<ActionResult<QueuedCommand>>;
}) {
  const t = useTranslations("run.commands");
  const ledgerCopy =
    command === "cancel"
      ? "ledgerCancel"
      : command === "pause"
        ? "ledgerPause"
        : "ledgerResume";
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<DeliveryMode>(DELIVERY_DEFAULT);
  const [failure, setFailure] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[] | null>(null);
  const steering = command === "steer";

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFailure(null);
      setQueued(null);
      setText("");
      setMode(DELIVERY_DEFAULT);
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write(text, mode);
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
              {t(ledgerControl ? `${ledgerCopy}.body` : `${command}.body`)}
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
              {t(
                ledgerControl
                  ? "ledgerReasonHelp"
                  : steering
                    ? "steerHelp"
                    : "reasonHelp",
              )}
            </p>
            {steering ? (
              <DeliveryPicker value={mode} onChange={setMode} />
            ) : null}
            {failure === null ? null : (
              <FormAlert testId={`run-${command}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t(
                ledgerControl ? `${ledgerCopy}.confirm` : `${command}.confirm`,
              )}
              pendingLabel={t(`${command}.pending`)}
            />
          </form>
        ) : (
          <div role="status" className="flex flex-col gap-3 text-sm">
            <p>
              {t(ledgerControl ? `${ledgerCopy}.applied` : `${command}.queued`)}
            </p>
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
  enforcementTier,
  ingressRevoked = false,
  ingressPaused = false,
  orgRole,
  wsRole,
}: {
  org: string;
  ws: string;
  runId: string;
  status: RunRow["status"];
  source: RunRow["source"];
  /** Where the run was observed from; an `observe` tier has no connection point. */
  enforcementTier: RunRow["enforcementTier"];
  /**
   * Why a command cannot reach the run, from the row; null or absent when it
   * can. Accepted ahead of #4034, which draws the controls from it.
   */
  commandBlock?: RunRow["commandBlock"];
  ingressRevoked?: boolean;
  ingressPaused?: boolean;
  orgRole: OrgRole;
  wsRole: WsRole;
}) {
  const t = useTranslations("run.commands");
  if (status !== "live") return null;
  if (source !== "ledger" && !acceptsCommands(enforcementTier)) {
    return (
      <DisabledControls
        reason={t("observeReason")}
        testId="observe-no-control"
      />
    );
  }
  if (!canCommandRun(orgRole, wsRole)) {
    return (
      <DisabledControls reason={t("roleReason")} testId="role-no-control" />
    );
  }
  if (source === "ledger" && ingressRevoked)
    return (
      <DisabledControls
        reason={t("ledgerRevoked")}
        testId="ledger-ingress-revoked"
      />
    );
  if (source === "ledger") {
    return (
      <div className="flex flex-col items-start gap-2 lg:items-end">
        <div className="flex flex-wrap gap-2">
          <CommandDialog
            command={ingressPaused ? "resume" : "pause"}
            runId={runId}
            ledgerControl
            write={(text) =>
              haltRun(org, ws, runId, ingressPaused ? "resume" : "pause", text)
            }
          />
          <button
            type="button"
            disabled
            data-testid="run-steer"
            className={buttonSecondary}
          >
            {t("steer.open")}
          </button>
          <CommandDialog
            command="cancel"
            runId={runId}
            ledgerControl
            write={(text) => haltRun(org, ws, runId, "cancel", text)}
          />
        </div>
        <p
          data-testid="ledger-control-limit"
          className="max-w-prose text-xs text-muted-foreground"
        >
          {t(ingressPaused ? "ledgerPaused" : "ledgerReason")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {COMMANDS.map((command) => (
        <CommandDialog
          key={command}
          command={command}
          runId={runId}
          write={(text, mode) =>
            command === "steer"
              ? steerRun(org, ws, runId, text, mode)
              : haltRun(org, ws, runId, command, text)
          }
        />
      ))}
    </div>
  );
}
