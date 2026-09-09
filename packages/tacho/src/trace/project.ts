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
  let turn: number | undefined;
  let turnCounter = 0;
  /** True after a `prompt_assembled` until the model response that answers it. */
  let promptOpen = false;

  const closePrompt = (at: string, toolCalls: string[]) => {
    drafts.push({ at, turn, event: "model_response", tool_calls: toolCalls });
    promptOpen = false;
  };

  for (const event of ordered) {
    switch (event.kind) {
      case "agent_start": {
        const body = event.body;
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
          drafts.push({
            at: event.ts,
            event: "resume",
            last_seq_seen: body.resume_last_seq_seen,
          });
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
        if (turn === undefined) {
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
        if (turn === undefined || event.body.tool_use_id === undefined) {
          break;
        }
        // The harness only shows us a request at the moment it is about to
        // execute; the model response that carried it is reconstructed here,
        // one response per request, which the loop oracle accepts.
        closePrompt(event.ts, [event.body.tool_use_id]);
        drafts.push({
          at: event.ts,
          turn,
          event: "tool_call",
          call_id: event.body.tool_use_id,
          tool: event.body.tool_name ?? "unknown",
        });
        break;
      }
      case "tool_call": {
        if (turn === undefined || event.body.tool_use_id === undefined) {
          break;
        }
        drafts.push({
          at: event.ts,
          turn,
          event: "tool_result",
          call_id: event.body.tool_use_id,
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
      case "token_denied": {
        if (
          turn === undefined ||
          event.body.tool_use_id === undefined ||
          event.body.policy_decision !== "deny"
        ) {
          break;
        }
        // A declined call is a resolution without an execution: the model
        // requested it, the harness answered `rejected`.
        closePrompt(event.ts, [event.body.tool_use_id]);
        drafts.push({
          at: event.ts,
          turn,
          event: "tool_result",
          call_id: event.body.tool_use_id,
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
          drafts.push({ at: event.ts, event: "session_end", outcome });
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    events: drafts.map(
      (draft, index) => ({ ...draft, seq: index + 1, session }) as TraceEvent,
    ),
  };
}
