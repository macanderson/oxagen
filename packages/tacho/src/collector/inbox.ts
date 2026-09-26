/**
 * Applying operator commands (spec section 7.4). Each command takes effect
 * in the registry (so the next hook boundary honours it), is chained as
 * `oxagen:command_applied` on the session it touched (or the daemon's own
 * chain for host-level commands), and is acknowledged back to the control
 * plane in the closed status vocabulary: `applied` with the seq that
 * recorded it, `received` for prompt content queued for the next boundary
 * (the hook that injects it acknowledges `applied` then), `expired` for a
 * command already past its deadline at receipt, or `failed` with the
 * reason.
 *
 * `cancel` and `kill` acknowledge what their signal did, not that the
 * command was processed. A refused signal, or a session record carrying no
 * pid, acknowledges `failed`: the process is still running, and the
 * `oxagen:kill_attempted` event beside the acknowledgement records the same
 * outcome. Reporting `applied` there puts a claim on the wire that the chain
 * contradicts. See `oxagen-roadmap:docs/oxagen/specs/local-supervisor/spec.md` §3.1.
 */
import { digestText } from "../claude-code/context";
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import {
  type CommandAcknowledgement,
  commandAcknowledgementSchema,
  type DeliveredCommand,
} from "../wire";
import {
  isInternalSession,
  type SessionRecord,
  type SessionRegistry,
} from "./registry";

export interface InboxDeps {
  registry: SessionRegistry;
  /** The daemon's own chain, for host-level commands. */
  hostRecorder: () => SessionRecorder;
  /** Send a signal; returns false when the process is gone or refuses. */
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  /**
   * When the process holding this pid started, in the form the registry
   * recorded it (`SessionFacts.pidInstance`), or undefined when that cannot
   * be read. Absent, nothing is compared.
   */
  processStart?: (pid: number) => string | undefined;
  refreshBundle: () => Promise<void>;
  onHostSuspended: (reason: string) => void;
  now: () => number;
  /**
   * The commands this host already answered. Absent, every delivery is
   * applied as it comes.
   */
  handled?: HandledCommands;
}

/** The most command ids `HandledCommands` remembers; the oldest goes first. */
export const HANDLED_COMMANDS_KEPT = 1024;

/**
 * The acknowledgement each command produced, by command id. The control
 * plane delivers a `sent` command again until an acknowledgement for it
 * lands, so an acknowledgement lost on the way back brings the same steer or
 * kill round a second time. A command found here is not applied again: its
 * first acknowledgement is queued once more instead.
 *
 * The daemon writes it to the sealed-state file beside the released
 * sessions (`list` and `restore`), in the state write that lands before the
 * acknowledgements leave, and only when `generation` moved. Held in memory
 * alone, a restart forgot it, and a steer the agent had already read was
 * queued and read a second time when the lost acknowledgement brought it
 * back.
 */
export class HandledCommands {
  private readonly acks = new Map<string, CommandAcknowledgement>();
  private changes = 0;

  constructor(private readonly limit = HANDLED_COMMANDS_KEPT) {}

  /** Moves on every change, so a writer knows when the file is behind. */
  get generation(): number {
    return this.changes;
  }

  get(commandId: string): CommandAcknowledgement | undefined {
    const ack = this.acks.get(commandId);
    return ack === undefined ? undefined : { ...ack };
  }

  remember(ack: CommandAcknowledgement): void {
    this.changes += 1;
    this.acks.delete(ack.command_id);
    this.acks.set(ack.command_id, { ...ack });
    for (const id of this.acks.keys()) {
      if (this.acks.size <= this.limit) break;
      this.acks.delete(id);
    }
  }

  /** Every remembered acknowledgement, oldest first, for the state file. */
  list(): CommandAcknowledgement[] {
    return [...this.acks.values()].map((ack) => ({ ...ack }));
  }

  /**
   * Take back the acknowledgements a state file held, oldest first. An entry
   * that is not an acknowledgement is skipped: the file is on the operator's
   * machine, and a bad entry must not stop the daemon from starting.
   */
  restore(entries: readonly unknown[]): void {
    for (const entry of entries) {
      const parsed = commandAcknowledgementSchema.safeParse(entry);
      if (parsed.success) this.remember(parsed.data);
    }
  }
}

export interface InboxResult {
  events: TachoEvent[];
  acknowledgements: CommandAcknowledgement[];
  /**
   * The commands that took effect on this host, in delivery order, for the
   * caller's follow-up (cutting a session's in-flight model calls). A
   * command acknowledged `expired`, or `failed` before it changed anything,
   * is left out, and so is a fan-out to every session that changed none. A
   * `cancel` or `kill` whose signal was not delivered is kept: the registry
   * recorded it, and cutting the model calls is the rest of that command.
   */
  applied: DeliveredCommand[];
}

/**
 * The operator's reason: the row's `reason` column as the wire carries it,
 * or `payload.reason` for a row queued before the column existed.
 */
function reasonOf(command: DeliveredCommand): string {
  if (command.reason !== null && command.reason.length > 0)
    return command.reason;
  const reason = command.payload["reason"];
  return typeof reason === "string" && reason.length > 0
    ? reason
    : `operator ${command.command}`;
}

function textOf(command: DeliveredCommand): string {
  const text = command.payload["text"] ?? command.payload["message"];
  return typeof text === "string" ? text : "";
}

function applied(
  recorder: SessionRecorder,
  command: DeliveredCommand,
  reasonCode: string,
  extra: Record<string, unknown> = {},
): TachoEvent {
  return recorder.sealCollectorEvent(
    "oxagen:command_applied",
    {
      policy_decision: command.command === "resume" ? "allow" : "deny",
      policy_source: "human",
      policy_reason_code: reasonCode,
      policy_reason_digest: digestText(reasonOf(command)),
      ...extra,
    },
    {
      attrs: {
        "command.id": command.id,
        "command.name": command.command,
        "command.issued_at": command.issued_at,
      },
    },
  );
}

type KillOutcome = "sent" | "failed" | "no_pid";

/**
 * Whether the pid now names a process that started at another time than
 * the one the session recorded: the harness exited and the OS gave its pid
 * to something else. Only a start time read now and different from the
 * recorded one counts. With none recorded (Windows has no `ps`, and a record
 * from an older state file has none) the bare pid stands, as it always has
 * on Windows; the sweep's `STALE_PID_SESSION_MS` bound is what limits that
 * exposure there. With none read now, the pid names no process, or `ps`
 * did not answer, and the signal itself reports a pid that is gone.
 */
function pidReused(record: SessionRecord, deps: InboxDeps): boolean {
  if (record.pid === undefined || record.pidInstance === undefined)
    return false;
  const now = deps.processStart?.(record.pid);
  return now !== undefined && now !== record.pidInstance;
}

function killAttempt(
  record: SessionRecord,
  command: DeliveredCommand,
  signal: "SIGTERM" | "SIGKILL",
  deps: InboxDeps,
): { event: TachoEvent; outcome: KillOutcome; reused: boolean } {
  let outcome: KillOutcome;
  let reused = false;
  if (record.pid === undefined) outcome = "no_pid";
  // The daemon never signals itself, whatever pid a record carries.
  else if (record.pid === process.pid) outcome = "failed";
  // The session's own process is gone, so it has no pid to signal. The
  // process holding the number now is not the agent's.
  else if (pidReused(record, deps)) {
    outcome = "no_pid";
    reused = true;
  } else outcome = deps.kill(record.pid, signal) ? "sent" : "failed";
  const event = record.recorder.sealCollectorEvent(
    "oxagen:kill_attempted",
    { kill_signal: signal, kill_outcome: outcome },
    {
      attrs: {
        "command.id": command.id,
        ...(record.pid !== undefined
          ? { "process.pid": String(record.pid) }
          : {}),
        ...(reused ? { "process.pid_reused": "1" } : {}),
      },
    },
  );
  return { event, outcome, reused };
}

function applyToSession(
  record: SessionRecord,
  command: DeliveredCommand,
  deps: InboxDeps,
): {
  events: TachoEvent[];
  status: CommandAcknowledgement["status"];
  detail?: string;
} {
  const events: TachoEvent[] = [];
  switch (command.command) {
    case "pause":
      record.control.paused = reasonOf(command);
      record.control.pauseEffect = undefined;
      events.push(applied(record.recorder, command, "session_paused"));
      return { events, status: "applied" };
    case "resume": {
      // A pause is a tool-call deny, not a halt: the model keeps generating
      // and usually ends its turn on the refusal. Clearing the flag alone
      // left a resumed agent idle. So a resume on an agent the pause refused
      // owes it a continuation, which the next boundary that carries text
      // delivers: a `PostToolUse` if the agent is still working, or the
      // `Stop` it is about to send, answered `decision: "block"` so the turn
      // goes on (`hook-handler.ts`).
      //
      // An agent that already ended its turn while paused sends no further
      // hook, and a synchronous hook answer cannot wake an idle session. Only
      // a background `asyncRewake` hook can, which the settings writer does
      // not install. Holding the paused `Stop` open instead would stall the
      // daemon's serial hook queue, and blocking it would spin the model
      // against denied tools until Claude Code's eight-block cap. So that
      // case is acknowledged `applied` with a detail saying the agent is idle
      // until its next prompt, and the Run page can say so.
      const effect = record.control.pauseEffect;
      record.control.paused = null;
      record.control.pauseEffect = undefined;
      if (effect === "refused") record.control.resumeOwed = command.id;
      events.push(applied(record.recorder, command, "session_resumed"));
      return effect === "stopped"
        ? {
            events,
            status: "applied",
            detail:
              "The agent ended its turn while paused and stays idle until its next prompt.",
          }
        : { events, status: "applied" };
    }
    case "cancel":
    case "kill": {
      const signal = command.command === "kill" ? "SIGKILL" : "SIGTERM";
      const reasonCode =
        command.command === "kill" ? "session_killed" : "session_cancelled";
      record.control.cancelled = reasonOf(command);
      record.control.resumeOwed = undefined;
      events.push(applied(record.recorder, command, reasonCode));
      const attempt = killAttempt(record, command, signal, deps);
      events.push(attempt.event);
      // The signal is the mechanism, so the acknowledgement reports what the
      // signal did. A refused signal or a record with no pid leaves the
      // process running, and `applied` would be a claim the chain contradicts:
      // the `oxagen:kill_attempted` event beside it says `failed` or `no_pid`.
      // The control plane may reissue the command; both paths are idempotent.
      if (attempt.outcome === "sent") return { events, status: "applied" };
      return {
        events,
        status: "failed",
        detail: attempt.reused
          ? `${signal} was not delivered (${attempt.outcome}: pid ${record.pid} now names another process)`
          : `${signal} was not delivered (${attempt.outcome})`,
      };
    }
    case "message":
    case "steer": {
      const text = textOf(command);
      if (text.length === 0)
        return {
          events,
          status: "failed",
          detail: `${command.command} payload has no text`,
        };
      // Queued once. The ledger answers a redelivery before it gets here, but
      // a ledger past its bound no longer holds an old command, and the
      // queue itself still does until a boundary takes it.
      if (record.control.messages.some((queued) => queued.id === command.id))
        return { events, status: "received" };
      record.control.messages.push({
        id: command.id,
        text,
        command: command.command,
        requestedMode: command.requested_mode,
        deliveryMode: command.delivery_mode,
        degradedReason: command.degraded_reason,
        expiresAt: command.expires_at,
        issuedAt: command.issued_at,
      });
      return { events, status: "received" };
    }
    case "refresh_bundle":
    case "revoke":
      return {
        events,
        status: "failed",
        detail: `${command.command} is a host command`,
      };
    default:
      return { events, status: "failed", detail: "unknown command" };
  }
}

/** Why a command cannot touch this session, or undefined when it can. */
function sessionRefusal(record: SessionRecord): string | undefined {
  // An ended chain takes no more frames, and the pid it stored may belong to
  // an unrelated process by now.
  if (record.sealed || record.pendingTerminal === true)
    return "session has ended";
  // The daemon's own chain is host bookkeeping, and its pid is the daemon's.
  if (isInternalSession(record.harnessSessionId)) return "not an agent session";
  return undefined;
}

/**
 * Whether a command changed the session: acknowledged `applied` or
 * `received`, or a `cancel` or `kill` the registry recorded although its
 * signal was not delivered.
 */
function changedSession(result: {
  events: readonly TachoEvent[];
  status: CommandAcknowledgement["status"];
}): boolean {
  return result.status !== "failed" || result.events.length > 0;
}

function expiredAt(command: DeliveredCommand, now: number): boolean {
  return command.expires_at !== null && Date.parse(command.expires_at) < now;
}

/**
 * Apply every delivered command; returns the chained events, the acks and
 * the commands that took effect.
 *
 * The caller writes the returned events to the WAL only once this returns.
 * An event sealed before an await would sit outside the log while a hook or
 * a model call sealed and wrote the next seq on the same chain, and the WAL
 * would hold that chain out of order. So a host-level `refresh_bundle`
 * fetches first, before anything is sealed, and every seal after it runs in
 * one synchronous stretch.
 */
export async function applyCommands(
  commands: readonly DeliveredCommand[],
  deps: InboxDeps,
): Promise<InboxResult> {
  const now = deps.now();
  // A redelivered command, or one listed twice, is answered from `handled`
  // once the rest are sealed, and nothing is applied for it.
  const fresh: DeliveredCommand[] = [];
  const repeated: string[] = [];
  for (const command of commands) {
    if (
      deps.handled !== undefined &&
      (deps.handled.get(command.id) !== undefined ||
        fresh.some((other) => other.id === command.id))
    )
      repeated.push(command.id);
    else fresh.push(command);
  }
  if (
    fresh.some(
      (command) =>
        command.session_uuid === null &&
        command.command === "refresh_bundle" &&
        !expiredAt(command, now),
    )
  )
    await deps.refreshBundle();
  const result = sealCommands(fresh, deps, now);
  for (const ack of result.acknowledgements) deps.handled?.remember(ack);
  for (const id of repeated) {
    const ack = deps.handled?.get(id);
    if (ack !== undefined) result.acknowledgements.push(ack);
  }
  return result;
}

function sealCommands(
  commands: readonly DeliveredCommand[],
  deps: InboxDeps,
  now: number,
): InboxResult {
  const events: TachoEvent[] = [];
  const acknowledgements: CommandAcknowledgement[] = [];
  const tookEffect: DeliveredCommand[] = [];
  for (const command of commands) {
    if (expiredAt(command, now)) {
      // The host holds the deadline for a command it received: one already
      // past its expiry at receipt reached no boundary, which is `expired`.
      acknowledgements.push({
        command_id: command.id,
        status: "expired",
        detail: "expired before the host could apply it",
      });
      continue;
    }
    if (command.session_uuid !== null) {
      const record = deps.registry.byUuid(command.session_uuid);
      if (record === undefined) {
        acknowledgements.push({
          command_id: command.id,
          status: "failed",
          detail: "session not on this host",
        });
        continue;
      }
      const refusal = sessionRefusal(record);
      if (refusal !== undefined) {
        acknowledgements.push({
          command_id: command.id,
          status: "failed",
          detail: refusal,
        });
        continue;
      }
      const result = applyToSession(record, command, deps);
      events.push(...result.events);
      if (changedSession(result)) tookEffect.push(command);
      const last = result.events[result.events.length - 1];
      acknowledgements.push({
        command_id: command.id,
        status: result.status,
        session_uuid: record.recorder.sessionUuid,
        ...(last !== undefined ? { applied_at_seq: last.seq } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      });
      continue;
    }
    // Host-level commands.
    switch (command.command) {
      case "refresh_bundle": {
        // Fetched above, before anything in this batch was sealed.
        const event = applied(deps.hostRecorder(), command, "bundle_refreshed");
        events.push(event);
        tookEffect.push(command);
        acknowledgements.push({
          command_id: command.id,
          status: "applied",
          applied_at_seq: event.seq,
        });
        break;
      }
      case "revoke": {
        deps.onHostSuspended(reasonOf(command));
        const event = applied(deps.hostRecorder(), command, "host_suspended");
        events.push(event);
        tookEffect.push(command);
        acknowledgements.push({
          command_id: command.id,
          status: "applied",
          applied_at_seq: event.seq,
        });
        break;
      }
      case "pause":
      case "resume":
      case "cancel":
      case "kill":
      case "message":
      case "steer": {
        let last: TachoEvent | undefined;
        let status: CommandAcknowledgement["status"] = "applied";
        // One host-level acknowledgement covers every live session, so it
        // reports the weakest outcome any of them reached. A fan-out that
        // failed on one session is not `applied` for the host.
        const details: string[] = [];
        let changedAny = false;
        for (const record of deps.registry.live()) {
          // Agent sessions only: the daemon's own chain is here too, and a
          // host-level cancel must not make the daemon signal itself.
          if (sessionRefusal(record) !== undefined) continue;
          const result = applyToSession(record, command, deps);
          events.push(...result.events);
          if (changedSession(result)) changedAny = true;
          last = result.events[result.events.length - 1] ?? last;
          if (result.status === "received" && status === "applied")
            status = "received";
          if (result.status === "failed") {
            status = "failed";
            if (result.detail !== undefined) details.push(result.detail);
          }
        }
        const hostEvent = applied(
          deps.hostRecorder(),
          command,
          `host_${command.command}`,
        );
        events.push(hostEvent);
        if (changedAny) tookEffect.push(command);
        acknowledgements.push({
          command_id: command.id,
          status,
          applied_at_seq: (last ?? hostEvent).seq,
          ...(details.length > 0 ? { detail: details.join("; ") } : {}),
        });
        break;
      }
      default:
        acknowledgements.push({
          command_id: command.id,
          status: "failed",
          detail: "unknown command",
        });
    }
  }
  return { events, acknowledgements, applied: tookEffect };
}
