/**
 * Applying operator commands (spec section 7.4). Each command takes effect
 * in the registry (so the next hook boundary honours it), is chained as
 * `oxagen:command_applied` on the session it touched (or the daemon's own
 * chain for host-level commands), and is acknowledged back to the control
 * plane in the closed status vocabulary: `applied` with the seq that
 * recorded it, `received` for prompt content queued for the next boundary
 * (the hook that injects it acknowledges `applied` then), or `failed` with
 * the reason.
 */
import { digestText } from "../claude-code/context";
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import type { CommandAcknowledgement, DeliveredCommand } from "../wire";
import type { SessionRecord, SessionRegistry } from "./registry";

export interface InboxDeps {
  registry: SessionRegistry;
  /** The daemon's own chain, for host-level commands. */
  hostRecorder: () => SessionRecorder;
  /** Send a signal; returns false when the process is gone or refuses. */
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  refreshBundle: () => Promise<void>;
  onHostSuspended: (reason: string) => void;
  now: () => number;
}

export interface InboxResult {
  events: TachoEvent[];
  acknowledgements: CommandAcknowledgement[];
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

function killAttempt(
  record: SessionRecord,
  command: DeliveredCommand,
  signal: "SIGTERM" | "SIGKILL",
  deps: InboxDeps,
): TachoEvent {
  let outcome: string;
  if (record.pid === undefined) outcome = "no_pid";
  else outcome = deps.kill(record.pid, signal) ? "sent" : "failed";
  return record.recorder.sealCollectorEvent(
    "oxagen:kill_attempted",
    { kill_signal: signal, kill_outcome: outcome },
    {
      attrs: {
        "command.id": command.id,
        ...(record.pid !== undefined
          ? { "process.pid": String(record.pid) }
          : {}),
      },
    },
  );
}

async function applyToSession(
  record: SessionRecord,
  command: DeliveredCommand,
  deps: InboxDeps,
): Promise<{
  events: TachoEvent[];
  status: CommandAcknowledgement["status"];
  detail?: string;
}> {
  const events: TachoEvent[] = [];
  switch (command.command) {
    case "pause":
      record.control.paused = reasonOf(command);
      events.push(applied(record.recorder, command, "session_paused"));
      return { events, status: "applied" };
    case "resume":
      record.control.paused = null;
      events.push(applied(record.recorder, command, "session_resumed"));
      return { events, status: "applied" };
    case "cancel": {
      record.control.cancelled = reasonOf(command);
      events.push(applied(record.recorder, command, "session_cancelled"));
      events.push(killAttempt(record, command, "SIGTERM", deps));
      return { events, status: "applied" };
    }
    case "kill": {
      record.control.cancelled = reasonOf(command);
      events.push(applied(record.recorder, command, "session_killed"));
      events.push(killAttempt(record, command, "SIGKILL", deps));
      return { events, status: "applied" };
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
      record.control.messages.push({
        id: command.id,
        text,
        command: command.command,
        requestedMode: command.requested_mode,
        deliveryMode: command.delivery_mode,
        degradedReason: command.degraded_reason,
        expiresAt: command.expires_at,
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

/** Apply every delivered command; returns the chained events and the acks. */
export async function applyCommands(
  commands: readonly DeliveredCommand[],
  deps: InboxDeps,
): Promise<InboxResult> {
  const events: TachoEvent[] = [];
  const acknowledgements: CommandAcknowledgement[] = [];
  const now = deps.now();
  for (const command of commands) {
    if (command.expires_at !== null && Date.parse(command.expires_at) < now) {
      // `expired` is the control plane's word; the host reports that it
      // could not apply a command whose expiry had already passed.
      acknowledgements.push({
        command_id: command.id,
        status: "failed",
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
      const result = await applyToSession(record, command, deps);
      events.push(...result.events);
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
        await deps.refreshBundle();
        const event = applied(deps.hostRecorder(), command, "bundle_refreshed");
        events.push(event);
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
        for (const record of deps.registry.live()) {
          const result = await applyToSession(record, command, deps);
          events.push(...result.events);
          last = result.events[result.events.length - 1] ?? last;
          if (result.status === "received") status = "received";
        }
        const hostEvent = applied(
          deps.hostRecorder(),
          command,
          `host_${command.command}`,
        );
        events.push(hostEvent);
        acknowledgements.push({
          command_id: command.id,
          status,
          applied_at_seq: (last ?? hostEvent).seq,
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
  return { events, acknowledgements };
}
