/**
 * How a wrapped (tacho) row's kind reads on a run frame: the half of its
 * exchange it records, the stage it belongs to, its one-line summary, and the
 * kind a legacy row is read as. Split from `run-frames.ts`, which reads the
 * rest of the row, so each file stays small enough to review.
 */
import type { FramePhase, TachoFrameRowLike } from "./run-frames";

/** Which half of its exchange a wrapped kind records. */
const TACHO_PHASES: Readonly<Record<string, FramePhase>> = {
  "model.request": "request",
  tool_requested: "request",
  "model.response": "response",
  tool_call: "response",
};

export function tachoPhase(kind: string): FramePhase {
  return TACHO_PHASES[kind] ?? "single";
}

/**
 * The half a wrapped frame records, read from its body where the kind alone
 * does not say.
 *
 * An `oxagen:message` that names `last_assistant_message_digest` is the
 * agent's own message, reported by a harness that sends it apart from the
 * turn's end (Cursor's `afterAgentResponse`). It is what came back, so it is a
 * response, and the transcript read gives it a half the page can show. Every
 * other `oxagen:message` (a prompt line from a transcript, a streamed delta)
 * stays a single frame: the turn already shows the prompt, and a delta is a
 * fragment of a message rather than the message.
 */
export function tachoFramePhase(kind: string, payload: unknown): FramePhase {
  if (
    kind === "oxagen:message" &&
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)[
      "last_assistant_message_digest"
    ] === "string"
  )
    return "response";
  return tachoPhase(kind);
}

/** The stage a wrapped kind belongs to (tacho spec §6.1 kinds). */
export function tachoStage(kind: string): string {
  switch (kind) {
    case "agent_start":
    case "agent_stop":
    case "subagent_start":
    case "subagent_stop":
      return "session";
    case "turn_start":
    case "turn_end":
      return "turn";
    case "llm_call":
    case "model.request":
    case "model.response":
    case "context.assembled":
    case "steering.manifest":
      return "model";
    case "tool_requested":
    case "tool_call":
    // The harness's own permission check belongs to the call it gated. It is
    // not an Oxagen decision, so it never reads as a policy frame.
    case "harness_permission":
      return "tool";
    case "policy_decision":
    case "approval_request":
    case "approval_decision":
    case "token_issued":
    case "token_use":
    case "token_denied":
    // An operator's pause, resume, cancel or steer as the host applied it.
    case "oxagen:command_applied":
      return "policy";
    case "file_io":
    case "network":
    case "command":
      return "effect";
    case "proof.observed":
      return "proof";
    default:
      return kind.startsWith("oxagen:") ? "control" : "chain";
  }
}

export function tachoFrameSummary(row: TachoFrameRowLike): string {
  switch (row.kind) {
    case "tool_requested":
    case "tool_call":
      return row.toolName
        ? `${row.toolName}${row.toolStatus ? ` ${row.toolStatus}` : ""}`
        : row.kind;
    case "llm_call":
      return row.model
        ? row.provider
          ? `${row.provider}/${row.model}`
          : row.model
        : row.kind;
    // A gate frame is about a call, and until now the summary dropped which
    // one: `policy allow` told a reader that something had been allowed and
    // gave them no way to learn what without opening the envelope. The
    // decision still leads, because that is what a reader scanning a run for
    // trouble is scanning for, and the subject follows it.
    case "policy_decision":
    case "harness_permission":
    case "approval_request":
    case "approval_decision": {
      if (row.policyDecision === "")
        return row.toolName === "" ? row.kind : `${row.kind} ${row.toolName}`;
      return row.toolName === ""
        ? `policy ${row.policyDecision}`
        : `${row.policyDecision} ${row.toolName}`;
    }
    // The command leads, because it is what the operator decided; the
    // recorded allow or deny is how the host carried it out.
    case "oxagen:command_applied": {
      const command = row.attrs?.["command.name"] ?? "";
      return command === "" ? row.kind : `operator ${command}`;
    }
    default:
      return row.kind;
  }
}

/**
 * The kind a stored row is read as. Before `harness_permission` existed, the
 * OTel adapter sealed Claude Code's own permission check as `policy_decision`
 * with `policy_source: "harness"`. Those rows stay in the store, so the reader
 * gives them the kind they would carry today.
 */
export function tachoKind(
  row: TachoFrameRowLike,
  policySource: string | null,
): string {
  if (
    row.kind === "policy_decision" &&
    (row.source ?? "").startsWith("otel") &&
    policySource === "harness"
  )
    return "harness_permission";
  return row.kind;
}
