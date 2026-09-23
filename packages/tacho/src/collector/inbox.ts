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

type KillOutcome = "sent" | "failed" | "no_pid";

function killAttempt(
  record: SessionRecord,
  command: DeliveredCommand,
  signal: "SIGTERM" | "SIGKILL",
  deps: InboxDeps,
): { event: TachoEvent; outcome: KillOutcome } {
  let outcome: KillOutcome;
  if (record.pid === undefined) outcome = "no_pid";
  else outcome = deps.kill(record.pid, signal) ? "sent" : "failed";
  const event = record.recorder.sealCollectorEvent(
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
  return { event, outcome };
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
    case "cancel":
    case "kill": {
      const signal = command.command === "kill" ? "SIGKILL" : "SIGTERM";
      const reasonCode =
        command.command === "kill" ? "session_killed" : "session_cancelled";
      record.control.cancelled = reasonOf(command);
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
        detail: `${signal} was not delivered (${attempt.outcome})`,
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
        // One host-level acknowledgement covers every live session, so it
        // reports the weakest outcome any of them reached. A fan-out that
        // failed on one session is not `applied` for the host.
        const details: string[] = [];
        for (const record of deps.registry.live()) {
          const result = await applyToSession(record, command, deps);
          events.push(...result.events);
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
  return { events, acknowledgements };
}
