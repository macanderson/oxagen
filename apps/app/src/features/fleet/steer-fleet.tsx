"use client";
// "Steer the fleet" (fleet.md, Header): every agent in the workspace, selected
// by default, with All and None; a Steering text field; and a Delivery block
// whose Interrupt switch is disabled and says it is not yet available.
//
// Sending queues one `dispatch_command` steer per selected agent at the turn
// boundary (`steerFleet` in ./actions). The control plane fans each out to the
// agent's runs in flight and answers one command id per run it reached, so the
// receipt counts runs, not agents. An agent with no run in flight is reached by
// nothing: the command table addresses live runs only, and the Delivery copy
// says so rather than promising a delivery at the agent's next run.
import { STEER_TEXT_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState, useTransition } from "react";
import type { RunRow } from "@/data/contracts/runs";
import { AgentCard } from "@/ui/agent-card";
import { Badge } from "@/ui/badge";
import { UNANSWERED, useActionFailure } from "@/ui/command-failure";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { StatusBadge } from "@/ui/status-badge";
import { type FleetSteer, steerFleet } from "./actions";
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
  const runWords = useTranslations("fleet.runs");
  const command = useTranslations("run.commands");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const textId = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(agents.map((agent) => agent.agentKey)),
  );
  const [text, setText] = useState("");
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
  const blocked = !canCommand || picked.length === 0 || text.trim() === "";

  function toggle(agentKey: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(agentKey);
    else next.delete(agentKey);
    setSelected(next);
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || pending) return;
    setFailure(null);
    startTransition(async () => {
      try {
        const result = await steerFleet(org, ws, {
          agentKeys: picked.map((agent) => agent.agentKey),
          text,
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
                {t("footer", { agents: picked.length, live: inFlight })}
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
            className={buttonPrimary}
          >
            {pending ? t("sending") : t("send")}
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
          <div
            role="group"
            aria-labelledby={`${formId}-agents`}
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                id={`${formId}-agents`}
                data-testid="steer-selected"
                className="text-xs font-medium"
              >
                {t("agents", {
                  selected: picked.length,
                  total,
                })}
              </span>
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
              <ul className="flex max-h-64 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {agents.map((agent) => {
                  const run = live.get(agent.agentKey);
                  const task = run?.name ?? run?.taskRef ?? "";
                  return (
                    <li key={agent.agentKey}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(agent.agentKey)}
                          aria-label={t("pick", { agent: agent.agentKey })}
                          onChange={(event) => {
                            toggle(agent.agentKey, event.target.checked);
                          }}
                          className="size-4 flex-none"
                        />
                        <span className="min-w-0 grow">
                          <AgentCard
                            agentKey={agent.agentKey}
                            notRecorded=""
                            sub={
                              run === undefined
                                ? t("idleSub")
                                : run.turns === null
                                  ? t("inFlightNoTurn", { run: run.id, task })
                                  : t("inFlight", {
                                      run: run.id,
                                      turn: run.turns,
                                      task,
                                    })
                            }
                          />
                        </span>
                        {run === undefined ? (
                          <Badge tone="quiet">{t("idle")}</Badge>
                        ) : parked.has(run.id) ? (
                          <Badge
                            tone="approval"
                            dot={false}
                            data-status="parked"
                          >
                            {runWords("parked")}
                          </Badge>
                        ) : (
                          <StatusBadge
                            status={run.status}
                            outcome={run.outcome}
                            vocabulary="lifecycle"
                          />
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
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
            <p className="text-xs text-muted-foreground">
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
              <div className="min-w-0 grow text-xs">
                <b className="block text-sm">{t("boundary")}</b>
                <span className="text-muted-foreground">
                  {t("boundaryBody")}
                </span>
              </div>
              <span className="flex flex-none flex-col items-end gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked="false"
                  aria-label={t("interrupt")}
                  aria-describedby={`${formId}-na`}
                  disabled
                  className="inline-flex min-h-8 items-center gap-2 rounded-full border border-border px-2.5 text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t("interrupt")}
                  <i
                    aria-hidden="true"
                    className="block h-3.5 w-6 rounded-full bg-border"
                  />
                </button>
                <span id={`${formId}-na`} className="text-[11px] text-dim">
                  {t("interruptUnavailable")}
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
