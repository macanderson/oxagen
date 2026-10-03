/**
 * Project one session's `tacho/1.0` events onto the `contextgraph-trace`
 * journal (docs/specs/tacho/spec.md section 6.4). The mapping is lossy by
 * design: the journal carries identities and costs only, never bodies, and
 * the oracles read the journal, not the harness.
 *
 * Journal `seq` is dense from 1 and independent of the Tacho `seq`: only the
 * events the vocabulary knows about produce lines. A session with an
 * `unobserved_tail` gap (no `agent_stop`) produces no `session_end`, which
 * the oracles correctly read as a crash.
 */
import { countsLlmCallUsage } from "../claude-code/llm-call-dedupe";
import type { TachoEvent } from "../envelope";
import type { Journal } from "./journal";
import { TRACE_FORMAT, type TraceEvent } from "./types";

export interface ProjectionOptions {
  /** `session` name in the journal; defaults to the Tacho session uuid. */
  session?: string;
  /** Context window announced for `prompt_assembled.budget_tokens`. */
  budgetTokens?: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type Draft = DistributiveOmit<TraceEvent, "seq" | "session">;

export function projectToTrace(
  events: readonly TachoEvent[],
  options: ProjectionOptions = {},
): Journal {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const session = options.session ?? ordered[0]?.session_uuid ?? "unknown";
  const drafts: Draft[] = [];
  /** The Tacho `seq` of the event each draft came from, index for index. */
  const origins: number[] = [];
  /**
   * Drafts a later event took back, by index: the `session_end` a resume
   * reopened, and the execution of a call the harness then refused.
   */
  const withdrawn = new Set<number>();
  /** Each `resume` draft's index, and the Tacho seq it says it saw through. */
  const resumes = new Map<number, number>();
  let turn: number | undefined;
  let turnCounter = 0;
  /** True after a `prompt_assembled` until the model response that answers it. */
  let promptOpen = false;
  /** The `session_end` draft the last `agent_stop` wrote, until a resume. */
  let sessionEndAt: number | undefined;
  /**
   * Call ids a `model_response` has requested and a `tool_result` has
   * answered. One call can reach the chain more than once: Oxagen seals its
   * verdict and then the refused request (`token_denied`), a refusal the
   * harness or the MCP gateway made lands after the request it refuses, and
   * a second source can report a result. The journal requests and answers
   * each call once.
   */
  const requested = new Set<string>();
  const resolved = new Set<string>();
  /** The `tool_call` draft each request wrote, by call id. */
  const executedAt = new Map<string, number>();
  /**
   * Where each Tacho turn number last appears. A `Stop` the daemon answers
   * with `decision: "block"` closes the turn on the chain, and the recorder
   * opens it again for the work that follows, which carries the same turn
   * number. That turn ends at its last `turn_end`.
   */
  const lastSeenAt = new Map<number, number>();
  ordered.forEach((event, index) => {
    const tachoTurn = event.turn?.turn_seq;
    if (tachoTurn !== undefined) lastSeenAt.set(tachoTurn, index);
  });

  const closePrompt = (at: string, toolCalls: string[]) => {
    drafts.push({ at, turn, event: "model_response", tool_calls: toolCalls });
    for (const id of toolCalls) requested.add(id);
    promptOpen = false;
  };

  for (const [index, event] of ordered.entries()) {
    switch (event.kind) {
      case "agent_start": {
        const body = event.body;
        // Claude Code starts the session again after every compaction, on
        // the same chain and often mid-turn, and the turn goes on. Older
        // hosts sealed that start with resume members, so the source is
        // what decides.
        if (body.session_start_source === "compact" && drafts.length > 0) {
          break;
        }
        if (
          body.resume_of_session_id !== undefined &&
          body.resume_last_seq_seen !== undefined
        ) {
          // A resumed session opens with its own genesis in Tacho; in the
          // journal that is a `resume` inside the same session recording,
          // which implicitly closes any open turn and orphans open calls.
          if (turn !== undefined && promptOpen) {
            promptOpen = false;
          }
          turn = undefined;
          // The session the resume reopens did not end.
          if (sessionEndAt !== undefined) {
            withdrawn.add(sessionEndAt);
            sessionEndAt = undefined;
          }
          resumes.set(drafts.length, body.resume_last_seq_seen);
          drafts.push({ at: event.ts, event: "resume", last_seq_seen: 0 });
          break;
        }
        drafts.push({
          at: event.ts,
          event: "session_start",
          agent: event.agent.agent_key,
          harness: `${event.agent.harness}/${event.agent.harness_version ?? "unknown"}`,
          ...(body.model !== undefined ? { model: body.model } : {}),
          trace_format: TRACE_FORMAT,
        });
        break;
      }
      case "turn_start": {
        if (turn !== undefined) {
          drafts.push({ at: event.ts, turn, event: "turn_end" });
        }
        turnCounter += 1;
        turn = turnCounter;
        promptOpen = false;
        drafts.push({ at: event.ts, turn, event: "turn_start" });
        break;
      }
      case "llm_call": {
        // One model call reaches the chain up to three times (proxy, OTel,
        // transcript), and only the row the control plane counts is the
        // call: a later sighting stamped `oxagen.llm_call_duplicate_of` or a
        // span mirroring its log record would otherwise open a second
        // prompt for a call that happened once.
        if (turn === undefined || !countsLlmCallUsage(event)) {
          break;
        }
        // A prompt still open here was answered with text only: close it
        // with an empty model response before assembling the next one.
        if (promptOpen) {
          closePrompt(event.ts, []);
        }
        drafts.push({
          at: event.ts,
          turn,
          event: "prompt_assembled",
          budget_tokens:
            options.budgetTokens ?? event.body.context_window ?? 200_000,
          declared_total_tokens: 0,
          frames: [],
        });
        promptOpen = true;
        break;
      }
      case "tool_requested": {
        const id = event.body.tool_use_id;
        if (turn === undefined || id === undefined || requested.has(id)) {
          break;
        }
        // The harness only shows us a request at the moment it is about to
        // execute; the model response that carried it is reconstructed here,
        // one response per request, which the loop oracle accepts.
        closePrompt(event.ts, [id]);
        executedAt.set(id, drafts.length);
        drafts.push({
          at: event.ts,
          turn,
          event: "tool_call",
          call_id: id,
          tool: event.body.tool_name ?? "unknown",
        });
        break;
      }
      case "tool_call": {
        const id = event.body.tool_use_id;
        if (turn === undefined || id === undefined || resolved.has(id)) {
          break;
        }
        resolved.add(id);
        drafts.push({
          at: event.ts,
          turn,
          event: "tool_result",
          call_id: id,
          status:
            event.body.tool_status === "rejected"
              ? "rejected"
              : event.body.tool_status === "error" ||
                  event.body.tool_status === "cancelled"
                ? "error"
                : "ok",
        });
        break;
      }
      case "policy_decision":
      case "harness_permission":
      case "token_denied": {
        const id = event.body.tool_use_id;
        if (
          turn === undefined ||
          id === undefined ||
          event.body.policy_decision !== "deny" ||
          resolved.has(id)
        ) {
          break;
        }
        // A declined call is a resolution without an execution: the model
        // requested it, the harness answered `rejected`. A call refused
        // after its request was recorded never ran, so the execution that
        // request wrote is taken back.
        if (requested.has(id)) {
          const executed = executedAt.get(id);
          if (executed !== undefined) withdrawn.add(executed);
        } else {
          closePrompt(event.ts, [id]);
        }
        resolved.add(id);
        drafts.push({
          at: event.ts,
          turn,
          event: "tool_result",
          call_id: id,
          status: "rejected",
        });
        break;
      }
      case "file_io":
      case "network":
      case "command": {
        if (turn === undefined || event.body.effect_id === undefined) {
          break;
        }
        drafts.push({
          at: event.ts,
          turn,
          event: "side_effect",
          effect_id: event.body.effect_id,
          kind: event.body.effect_kind ?? event.kind,
          ...(event.body.tool_use_id !== undefined
            ? { call_id: event.body.tool_use_id }
            : {}),
        });
        break;
      }
      case "turn_end": {
        if (turn === undefined) {
          break;
        }
        // A later frame of the same Tacho turn means the agent went on.
        const tachoTurn = event.turn?.turn_seq;
        if (
          tachoTurn !== undefined &&
          (lastSeenAt.get(tachoTurn) ?? index) > index
        ) {
          break;
        }
        if (promptOpen) {
          closePrompt(event.ts, []);
        }
        drafts.push({ at: event.ts, turn, event: "turn_end" });
        turn = undefined;
        break;
      }
      case "agent_stop": {
        if (turn !== undefined) {
          if (promptOpen) {
            closePrompt(event.ts, []);
          }
          drafts.push({ at: event.ts, turn, event: "turn_end" });
          turn = undefined;
        }
        const outcome = event.body.session_outcome;
        if (outcome === "completed" || outcome === "aborted") {
          sessionEndAt = drafts.length;
          drafts.push({ at: event.ts, event: "session_end", outcome });
        }
        break;
      }
      default:
        break;
    }
    while (origins.length < drafts.length) origins.push(event.seq);
  }

  const kept: number[] = [];
  drafts.forEach((_, index) => {
    if (!withdrawn.has(index)) kept.push(index);
  });
  /** How many of these lines came from an event at or before a Tacho seq. */
  const linesThrough = (lines: readonly number[], tachoSeq: number): number =>
    lines.filter((index) => (origins[index] ?? 0) <= tachoSeq).length;
  return {
    events: kept.map((index, position) => {
      const draft = drafts[index] as Draft;
      const sawThrough = resumes.get(index);
      // A resume names the Tacho seq it saw through. The journal numbers its
      // own lines, so the claim becomes the journal seq of the last line
      // that came from an event at or before that seq.
      const line: Draft =
        sawThrough === undefined || draft.event !== "resume"
          ? draft
          : {
              ...draft,
              last_seq_seen: linesThrough(kept.slice(0, position), sawThrough),
            };
      return { ...line, seq: position + 1, session } as TraceEvent;
    }),
  };
}
