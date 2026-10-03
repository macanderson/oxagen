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
import type { PendingWorkOrder } from "../host/work-orders";
import {
  type CommandAcknowledgement,
  commandAcknowledgementSchema,
  type DeliveredCommand,
  workOrderCommandPayloadSchema,
} from "../wire";
import {
  onSessionQueue,
  type RecordSink,
  recordOutcomeOnChain,
  type SessionExclusive,
} from "./chain-write";
import { applyInterjectionAnswer, interjectionAnswerOf } from "./interjection";
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
  /**
   * Keep a work order the control plane sent this host until the person at
   * the machine starts it (ADR-251). Synchronous, because every seal after
   * the bundle refresh runs in one stretch. It throws when the order cannot
   * be written. Absent, a `work_order` command fails: this host has nowhere
   * to keep it.
   */
  keepWorkOrder?: (order: PendingWorkOrder) => void;
  /**
   * Write sealed frames, and their bodies, to the WAL: the daemon's
   * `record`. Given, each command's frames are written in the stretch that
   * seals them, and `events` holds the frames that landed. Absent, nothing
   * is written here: the caller writes `events`, and runs `restore` when
   * that write fails.
   */
  record?: RecordSink;
  /**
   * Run a command's seals on its session's queue, where the session's hooks
   * run (`chain-write.ts`). Absent, they run as the command is applied.
   */
  exclusive?: SessionExclusive;
  /** Where a command whose frames could not be written is reported. */
  log?: (line: string) => void;
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

  /**
   * Drop a command's acknowledgement, so its next delivery is applied again.
   * For a command whose frames never reached the WAL.
   */
  forget(commandId: string): void {
    if (this.acks.delete(commandId)) this.changes += 1;
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
  /**
   * The frames the commands sealed. With `record` in the deps they are on
   * the WAL already.
   */
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
  /**
   * Puts back what these commands changed in memory that a chain rollback
   * does not reach: each question an answer released, each message they
   * queued, and their acknowledgements in `handled`. The caller runs it when
   * the WAL write of `events` fails. Without it, the redelivered answer was
   * answered from the ledger or found no question held, and the chain never
   * recorded the answer (#3941). A question something else settled or raised
   * since is left as it is.
   *
   * With `record` in the deps this does nothing. The inbox wrote each
   * command's frames itself and put back each command whose frames did not
   * land, and undoing the rest would unwind commands the WAL holds.
   */
  restore: () => void;
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
  undo: Array<() => void>,
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
      // session's hook queue, and blocking it would spin the model
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
      // The answer to the question the host holds the session's loop on
      // (#3941) rides a `message`, so a host built before it delivers the
      // text and nothing else. This host settles the question first: it
      // seals the answer and what it did, and lets prompts through again.
      // An answer to a question this session does not hold (settled by the
      // host's own timeout, or never raised here) seals nothing and is not
      // delivered: the agent was already told how it was settled.
      const answer =
        command.command === "message"
          ? interjectionAnswerOf(command.payload)
          : undefined;
      if (answer !== undefined) {
        const held = record.control.interjection;
        const settled = applyInterjectionAnswer(record, answer, command.id);
        if (settled === undefined)
          return {
            events,
            status: "failed",
            detail: "no question under this key is held on the session",
          };
        undo.push(() => {
          if (record.control.interjection === undefined)
            record.control.interjection = held;
        });
        events.push(...settled);
      }
      const text = textOf(command);
      // A settled answer with nothing to tell the agent applied in full.
      if (text.length === 0 && answer !== undefined)
        return { events, status: "applied" };
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
      undo.push(() => {
        const at = record.control.messages.findIndex(
          (queued) => queued.id === command.id,
        );
        if (at >= 0) record.control.messages.splice(at, 1);
      });
      return { events, status: "received" };
    }
    case "refresh_bundle":
    case "revoke":
    case "work_order":
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

/**
 * A `work_order` command (ADR-251): keep the order for the person at the
 * machine and acknowledge `received`. Nothing starts here, and nothing is
 * sealed. The run starts when the person runs `oxagen work start`, which
 * claims the order first. A payload that does not name an order, a key, and
 * a work item fails with the reason.
 */
function keepWorkOrderCommand(
  command: DeliveredCommand,
  deps: InboxDeps,
  now: number,
): CommandAcknowledgement {
  const payload = workOrderCommandPayloadSchema.safeParse(command.payload);
  if (!payload.success)
    return {
      command_id: command.id,
      status: "failed",
      detail:
        "work_order payload must name work_order (wo_...), key, and item (wi_...)",
    };
  if (deps.keepWorkOrder === undefined)
    return {
      command_id: command.id,
      status: "failed",
      detail: "this host has nowhere to keep a work order",
    };
  try {
    deps.keepWorkOrder({
      command_id: command.id,
      work_order: payload.data.work_order,
      key: payload.data.key,
      item: payload.data.item,
      received_at: new Date(now).toISOString(),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The acknowledgement's detail is bounded at 512 characters.
    const detail = `could not keep the work order: ${reason}`;
    return {
      command_id: command.id,
      status: "failed",
      detail: detail.slice(0, 512),
    };
  }
  return { command_id: command.id, status: "received" };
}

function expiredAt(command: DeliveredCommand, now: number): boolean {
  return command.expires_at !== null && Date.parse(command.expires_at) < now;
}

/**
 * Apply every delivered command; returns the chained events, the acks and
 * the commands that took effect.
 *
 * A host-level `refresh_bundle` fetches first, before anything is sealed.
 * Then the commands apply in delivery order. With `record` in the deps, each
 * command's frames are written in the stretch that seals them: a session's
 * on that session's queue (`exclusive`), because a hook there can seal,
 * await, and write later, and the daemon's own chain right where it seals,
 * because that chain has no queue and every writer seals and writes it in
 * one synchronous stretch. A frame sealed and written later, across an
 * await, could lose its seq to a hook or a model call that sealed and wrote
 * the same chain in between, and the WAL would refuse it.
 *
 * Without `record`, the caller writes the returned events once this returns,
 * and runs `restore` when that write fails.
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
  const result = await sealCommands(fresh, deps, now);
  for (const ack of result.acknowledgements) deps.handled?.remember(ack);
  for (const id of repeated) {
    const ack = deps.handled?.get(id);
    if (ack !== undefined) result.acknowledgements.push(ack);
  }
  if (deps.record !== undefined) return { ...result, restore: () => {} };
  const restoreSessions = result.restore;
  return {
    ...result,
    // A command whose frames never landed is applied again when the plane
    // delivers it next, rather than answered from the ledger.
    restore: () => {
      restoreSessions();
      for (const command of fresh) deps.handled?.forget(command.id);
    },
  };
}

/**
 * Seal on one chain, and with `record` in the deps write what was sealed in
 * the same stretch (`recordOutcomeOnChain`). A write that fails takes that
 * chain back and throws. Without `record` the caller writes the events.
 */
function sealOn<T extends { readonly events: readonly TachoEvent[] }>(
  chain: SessionRecorder,
  seal: () => T,
  deps: InboxDeps,
): T {
  return deps.record === undefined
    ? seal()
    : recordOutcomeOnChain(chain, () => seal(), deps.record);
}

/**
 * Leave a command whose frames could not be written unacknowledged, and so
 * unremembered: the control plane delivers it again, and it applies then.
 */
function unwritten(
  command: DeliveredCommand,
  error: unknown,
  deps: InboxDeps,
): void {
  deps.log?.(
    `operator command ${command.id} (${command.command}) is not acknowledged: its frames could not be written (${error instanceof Error ? error.message : String(error)}). The control plane delivers it again.`,
  );
}

/** What one command did on one session. */
type SessionOutcome =
  | { kind: "refused"; detail: string }
  | {
      kind: "applied";
      record: SessionRecord;
      events: readonly TachoEvent[];
      status: CommandAcknowledgement["status"];
      detail?: string;
      /** What puts back the command's changes in memory. */
      undo: Array<() => void>;
    }
  | { kind: "unwritten"; record: SessionRecord; error: unknown };

/**
 * Apply one command to one session on that session's queue, and write what
 * it sealed in the same stretch. The record is looked up again there,
 * because the session can end, or its record be replaced
 * (`SessionRegistry.restore`), while the command waits. A write that fails
 * takes back this session's chain alone and puts back what the command
 * changed in memory.
 */
function onSession(
  found: SessionRecord,
  command: DeliveredCommand,
  deps: InboxDeps,
): Promise<SessionOutcome> {
  return onSessionQueue(deps.exclusive, found, (): SessionOutcome => {
    const record = deps.registry.byUuid(found.recorder.sessionUuid);
    if (record === undefined)
      return { kind: "refused", detail: "session not on this host" };
    const refusal = sessionRefusal(record);
    if (refusal !== undefined) return { kind: "refused", detail: refusal };
    const undo: Array<() => void> = [];
    try {
      const result = sealOn(
        record.recorder,
        () => applyToSession(record, command, deps, undo),
        deps,
      );
      return { kind: "applied", record, ...result, undo };
    } catch (error) {
      for (const step of [...undo].reverse()) step();
      if (deps.record === undefined) throw error;
      return { kind: "unwritten", record, error };
    }
  });
}

/**
 * Seal one frame on the daemon's own chain, and write it in the same stretch.
 * Undefined when the write failed: the chain is taken back, and the command
 * is left for the control plane to deliver again.
 */
function onHost(
  command: DeliveredCommand,
  deps: InboxDeps,
  seal: (host: SessionRecorder) => TachoEvent,
): TachoEvent | undefined {
  const host = deps.hostRecorder();
  try {
    return sealOn(
      host,
      () => {
        const event = seal(host);
        return { events: [event], event };
      },
      deps,
    ).event;
  } catch (error) {
    if (deps.record === undefined) throw error;
    unwritten(command, error, deps);
    return undefined;
  }
}

async function sealCommands(
  commands: readonly DeliveredCommand[],
  deps: InboxDeps,
  now: number,
): Promise<InboxResult> {
  const events: TachoEvent[] = [];
  const acknowledgements: CommandAcknowledgement[] = [];
  const tookEffect: DeliveredCommand[] = [];
  const undo: Array<() => void> = [];
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
      const found = deps.registry.byUuid(command.session_uuid);
      if (found === undefined) {
        acknowledgements.push({
          command_id: command.id,
          status: "failed",
          detail: "session not on this host",
        });
        continue;
      }
      const outcome = await onSession(found, command, deps);
      if (outcome.kind === "refused") {
        acknowledgements.push({
          command_id: command.id,
          status: "failed",
          detail: outcome.detail,
        });
        continue;
      }
      if (outcome.kind === "unwritten") {
        unwritten(command, outcome.error, deps);
        continue;
      }
      events.push(...outcome.events);
      undo.push(...outcome.undo);
      if (changedSession(outcome)) tookEffect.push(command);
      const last = outcome.events[outcome.events.length - 1];
      acknowledgements.push({
        command_id: command.id,
        status: outcome.status,
        session_uuid: outcome.record.recorder.sessionUuid,
        ...(last !== undefined ? { applied_at_seq: last.seq } : {}),
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      });
      continue;
    }
    // Host-level commands.
    switch (command.command) {
      case "refresh_bundle": {
        // Fetched above, before anything in this batch was sealed.
        const event = onHost(command, deps, (host) =>
          applied(host, command, "bundle_refreshed"),
        );
        if (event === undefined) break;
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
        const event = onHost(command, deps, (host) =>
          applied(host, command, "host_suspended"),
        );
        if (event === undefined) break;
        events.push(event);
        tookEffect.push(command);
        acknowledgements.push({
          command_id: command.id,
          status: "applied",
          applied_at_seq: event.seq,
        });
        break;
      }
      case "work_order":
        acknowledgements.push(keepWorkOrderCommand(command, deps, now));
        break;
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
        let reached = 0;
        // Agent sessions only: the daemon's own chain is here too, and a
        // host-level cancel must not make the daemon signal itself. Each
        // session applies on its own queue, so the sessions wait on one
        // another only through this command.
        const outcomes = await Promise.all(
          deps.registry
            .live()
            .filter((record) => sessionRefusal(record) === undefined)
            .map((record) => onSession(record, command, deps)),
        );
        for (const outcome of outcomes) {
          // A session that ended while the command waited on its queue.
          if (outcome.kind === "refused") continue;
          reached += 1;
          if (outcome.kind === "unwritten") {
            // What landed on the other sessions stands, so the command is
            // answered, and this session's part of it failed.
            status = "failed";
            details.push(
              `frames not written on session ${outcome.record.recorder.sessionUuid}`,
            );
            deps.log?.(
              `operator command ${command.id} (${command.command}) did not apply to session ${outcome.record.harnessSessionId}: its frames could not be written (${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)})`,
            );
            continue;
          }
          events.push(...outcome.events);
          undo.push(...outcome.undo);
          if (changedSession(outcome)) changedAny = true;
          last = outcome.events[outcome.events.length - 1] ?? last;
          if (outcome.status === "received" && status === "applied")
            status = "received";
          if (outcome.status === "failed") {
            status = "failed";
            if (outcome.detail !== undefined) details.push(outcome.detail);
          }
        }
        // A fan-out that reached no agent session changed nothing, so it is
        // not `applied`, and the daemon's chain records no command applied
        // (#2953). The control plane holds a steer for an idle agent's next
        // run itself, so this is a command that came with no session to act
        // on.
        if (reached === 0) {
          acknowledgements.push({
            command_id: command.id,
            status: "failed",
            detail: "no live agent session on this host",
          });
          break;
        }
        // The sessions it changed stay changed whether or not the daemon's
        // chain records it, and cutting their model calls is the rest of it.
        if (changedAny) tookEffect.push(command);
        const hostEvent = onHost(command, deps, (host) =>
          applied(host, command, `host_${command.command}`),
        );
        if (hostEvent === undefined) break;
        events.push(hostEvent);
        acknowledgements.push({
          command_id: command.id,
          status,
          applied_at_seq: (last ?? hostEvent).seq,
          ...(details.length > 0
            ? { detail: details.join("; ").slice(0, 512) }
            : {}),
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
  return {
    events,
    acknowledgements,
    applied: tookEffect,
    restore: () => {
      for (const step of [...undo].reverse()) step();
    },
  };
}
