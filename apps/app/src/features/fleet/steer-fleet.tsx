"use client";
// "Steer the fleet" (fleet.md, Header; agents.md, steerfleet): every agent in
// the workspace, selected by default in a typeahead picker, with All and
// None; a Steering text field; and a Delivery block with an Interrupt switch.
//
// Sending queues one `dispatch_command` steer per selected agent
// (`steerFleet` in ./actions). The control plane fans each out to the agent's
// runs in flight and answers one command id per run it reached. An agent with
// no run in flight gets one command held for its next run (#2953), so the
// receipt counts commands, not runs.
//
// Interrupt asks for `interrupt` as a ceiling. Each run's connection point
// carries the strongest mode it can at or below it, and the command records
// both. The switch is offered when a selected agent has a run in flight whose
// model calls pass through the host's proxy, which can cut a call in flight:
// the `gateway` and `contained` tiers (ADR-094, ADR-095). With none, the
// switch stays disabled and says why.
import { STEER_TEXT_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState, useTransition } from "react";
import {
  commandBlockOf,
  type EnforcementTier,
  type RunRow,
} from "@/data/contracts/runs";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import {
  buttonDanger,
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { type PickerOption, RecordMultiPicker } from "@/ui/record-picker";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type FleetSteer, type FleetSteerMode, steerFleet } from "./actions";
import type { FleetAgent } from "./board";

/** The newest live run of each agent, from the runs Fleet read (newest first). */
function liveRunByAgent(runs: readonly RunRow[]): Map<string, RunRow> {
  const live = new Map<string, RunRow>();
  for (const run of runs)
    if (
      run.status === "live" &&
      run.agentKey !== null &&
      !live.has(run.agentKey)
    )
      live.set(run.agentKey, run);
  return live;
}

/**
 * The tiers whose model calls pass through the host's loopback proxy, which
 * can cut a call in flight (ADR-094, ADR-095). `dispatch_command` delivers
 * `interrupt` there and degrades it elsewhere.
 */
const INTERRUPT_TIERS: ReadonlySet<EnforcementTier> = new Set([
  "gateway",
  "contained",
]);

/**
 * The agents with a run in flight that can carry an interrupt: a wrapped run
 * (a steer to an agent reaches its wrapped sessions only), on a tier whose
 * proxy can cut the call, reachable by its host, and on a harness that takes
 * steering text mid-run.
 */
function interruptCarriers(runs: readonly RunRow[]): Set<string> {
  const carriers = new Set<string>();
  for (const run of runs)
    if (
      run.status === "live" &&
      run.source === "tacho" &&
      run.agentKey !== null &&
      INTERRUPT_TIERS.has(run.enforcementTier) &&
      commandBlockOf(run) === null &&
      (run.steerBlock ?? null) === null
    )
      carriers.add(run.agentKey);
  return carriers;
}

export function SteerFleetDialog({
  org,
  ws,
  workspace,
  agents,
  agentsRead,
  agentTotal,
  agentsComplete,
  runs,
  parkedRunIds,
  canCommand,
  onClose,
}: {
  org: string;
  ws: string;
  workspace: string;
  agents: FleetAgent[];
  agentsRead: boolean;
  /** Identities in the workspace, the M of "N of M selected"; null when unread. */
  agentTotal: number | null;
  /** False when the roster stopped before the workspace's last agent. */
  agentsComplete: boolean;
  runs: RunRow[];
  /** Live runs with a call parked for approval, which read "parked for approval". */
  parkedRunIds: readonly string[];
  canCommand: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("fleet.steer");
  const command = useTranslations("run.commands");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const textId = useId();
  const pickerId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(agents.map((agent) => agent.agentKey)),
  );
  const [text, setText] = useState("");
  const [interrupt, setInterrupt] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<FleetSteer | null>(null);
  const [pending, startTransition] = useTransition();
  const live = liveRunByAgent(runs);
  const parked = new Set(parkedRunIds);
  const total = agentTotal ?? agents.length;
  // Agents the list cannot show: past where the roster stopped, or with no
  // agent key, which a steer cannot address.
  const unlisted = Math.max(0, total - agents.length);
  const picked = agents.filter((agent) => selected.has(agent.agentKey));
  const inFlight = picked.filter((agent) => live.has(agent.agentKey)).length;
  const carriers = interruptCarriers(runs);
  const interruptible = picked.filter((agent) =>
    carriers.has(agent.agentKey),
  ).length;
  // Derived, so a selection that loses its last carrier turns Interrupt off.
  const interrupting = interrupt && interruptible > 0;
  const mode: FleetSteerMode = interrupting ? "interrupt" : "turn_boundary";
  const blocked = !canCommand || picked.length === 0 || text.trim() === "";

  // Each agent is offered by its key, with what it has in flight on the
  // second line: the run, its turn and task, or that it is idle or parked.
  const options: PickerOption[] = agents.map((agent) => {
    const run = live.get(agent.agentKey);
    const state = run !== undefined && parked.has(run.id) ? "parked" : "live";
    const task = run?.name ?? run?.taskRef ?? "";
    return {
      value: agent.agentKey,
      label: agent.agentKey,
      detail:
        run === undefined
          ? t("idle")
          : run.turns === null
            ? t("inFlightNoTurn", { state, run: run.id, task })
            : t("inFlight", { state, run: run.id, turn: run.turns, task }),
    };
  });

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || pending) return;
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await steerFleet(org, ws, {
          agentKeys: picked.map((agent) => agent.agentKey),
          text,
          requestedMode: mode,
        });
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

  return (
    <SheetDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      testId="steer-fleet-dialog"
      {...(receipt === null
        ? {
            // The footer reads Cancel, so the header's x is the one "Close".
            // The receipt's footer is Close itself, so it draws no x.
            headerClose: true,
            closeLabel: t("cancel"),
            footerNote: (
              <span data-testid="steer-summary">
                {t("footer", {
                  agents: picked.length,
                  live: inFlight,
                  mode: interrupting ? "interrupt" : "boundary",
                })}
              </span>
            ),
          }
        : {})}
      footer={
        receipt === null ? (
          <button
            type="submit"
            form={formId}
            data-touch-target=""
            disabled={blocked || pending}
            className={interrupting ? buttonDanger : buttonPrimary}
          >
            {pending
              ? t("sending")
              : interrupting
                ? t("sendInterrupt")
                : t("send")}
          </button>
        ) : undefined
      }
    >
      {receipt !== null ? (
        <div
          role="status"
          data-testid="steer-receipt"
          className="flex flex-col gap-2 text-sm"
        >
          <p>{t("queued", { count: receipt.commandIds.length })}</p>
          {receipt.commandIds.length === 0 ? null : (
            <p className="text-muted-foreground">{t("queuedDetail")}</p>
          )}
          {receipt.refused.length === 0 ? null : (
            <p className="text-muted-foreground">
              {t("refused", {
                count: receipt.refused.length,
                codes: receipt.refused
                  .map((item) => `${item.agentKey} (${item.code})`)
                  .join(", "),
              })}
            </p>
          )}
        </div>
      ) : (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor={pickerId}
                data-testid="steer-selected"
                className="text-xs font-medium"
              >
                {t("agents", {
                  selected: picked.length,
                  total,
                })}
              </label>
              <span className="flex gap-1.5">
                <button
                  type="button"
                  data-touch-target=""
                  className={`${buttonSecondary} px-2 py-0.5 text-xs`}
                  onClick={() => {
                    setSelected(new Set(agents.map((agent) => agent.agentKey)));
                  }}
                >
                  {t("all")}
                </button>
                <button
                  type="button"
                  data-touch-target=""
                  className={`${buttonSecondary} px-2 py-0.5 text-xs`}
                  onClick={() => {
                    setSelected(new Set());
                  }}
                >
                  {t("none")}
                </button>
              </span>
            </div>
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {agentsRead ? t("noAgents") : t("agentsUnread")}
              </p>
            ) : (
              <RecordMultiPicker
                id={pickerId}
                options={options}
                value={picked.map((agent) => agent.agentKey)}
                onChange={(keys) => {
                  setSelected(new Set(keys));
                }}
                placeholder={t("search")}
                aria-describedby={`${formId}-hint`}
                data-testid="steer-agents"
              />
            )}
            {unlisted === 0 ? null : (
              <p
                data-testid="steer-unlisted"
                className="text-xs text-muted-foreground"
              >
                {agentsComplete
                  ? t("keyless", { count: unlisted })
                  : t("stopped", { listed: agents.length, count: unlisted })}
              </p>
            )}
            <p id={`${formId}-hint`} className="text-xs text-muted-foreground">
              {t("hint", { workspace })}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={textId} className="text-xs font-medium">
              {t("text")}
            </label>
            <textarea
              id={textId}
              rows={3}
              maxLength={STEER_TEXT_MAX}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
              className={`${inputBase} resize-y max-md:min-h-11 max-md:text-base`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">{t("delivery")}</span>
            <div className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
              <div className="min-w-0 grow text-xs" data-testid="steer-mode">
                <b className="block text-sm">
                  {interrupting ? t("interruptNow") : t("boundary")}
                </b>
                <span className="text-muted-foreground">
                  {interrupting ? t("interruptBody") : t("boundaryBody")}
                </span>
              </div>
              <span className="flex flex-none flex-col items-end gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked={interrupting}
                  aria-label={t("interrupt")}
                  aria-describedby={`${formId}-interrupt`}
                  disabled={interruptible === 0}
                  onClick={() => {
                    setInterrupt(!interrupting);
                  }}
                  className={`inline-flex min-h-8 items-center gap-2 rounded-full border px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-60 ${
                    interrupting
                      ? "border-info text-info"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {t("interrupt")}
                  <i
                    aria-hidden="true"
                    className={`block h-3.5 w-6 rounded-full ${
                      interrupting ? "bg-info" : "bg-border"
                    }`}
                  />
                </button>
                <span
                  id={`${formId}-interrupt`}
                  data-testid="steer-interrupt-reason"
                  className="max-w-48 text-right text-[11px] text-dim"
                >
                  {interruptible > 0
                    ? t("interruptCarriers", { count: interruptible })
                    : inFlight > 0
                      ? t("interruptNoCarrier")
                      : t("interruptNoRun")}
                </span>
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t.rich("interruptHint", {
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t.rich("recorded", {
                mono: (chunks) => <span className={mono}>{chunks}</span>,
              })}
            </p>
          </div>
          <p className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground">
            {t("note")}
          </p>
          {canCommand ? null : (
            <p
              data-testid="steer-role"
              className="text-xs text-muted-foreground"
            >
              {command("roleReason")}
            </p>
          )}
          {failure === null ? null : (
            <FormAlert testId="steer-failure">{failure}</FormAlert>
          )}
        </form>
      )}
    </SheetDialog>
  );
}
