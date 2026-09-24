import { describe, expect, it } from "vitest";
import { LLM_CALL_DUPLICATE_OF_ATTR } from "../claude-code/llm-call-dedupe";
import { sealAll, unsealed } from "../test-helpers";
import { runOracles } from "./oracles";
import { projectToTrace } from "./project";
import { reportPassed } from "./report";

const TURN = { turn: { turn_seq: 1 } };

describe("projection of one model call reported by several sources", () => {
  it("opens one prompt for the call, not one per sighting", () => {
    const events = sealAll([
      unsealed("agent_start", {}),
      unsealed("turn_start", {}, TURN),
      unsealed(
        "llm_call",
        { request_id: "req_1", input_tokens: 10 },
        { ...TURN, source: "collector" },
      ),
      unsealed(
        "llm_call",
        { request_id: "req_1", input_tokens: 10 },
        {
          ...TURN,
          source: "otel_log",
          attrs: { [LLM_CALL_DUPLICATE_OF_ATTR]: "collector" },
        },
      ),
      unsealed(
        "llm_call",
        { request_id: "req_1" },
        {
          ...TURN,
          source: "otel_span",
        },
      ),
      unsealed(
        "llm_call",
        { request_id: "req_1", input_tokens: 10 },
        {
          ...TURN,
          source: "transcript",
          attrs: { [LLM_CALL_DUPLICATE_OF_ATTR]: "collector" },
        },
      ),
      unsealed("turn_end", {}, TURN),
      unsealed("agent_stop", { session_outcome: "completed" }),
    ]);
    const journal = projectToTrace(events);
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "prompt_assembled",
      "model_response",
      "turn_end",
      "session_end",
    ]);
    expect(reportPassed(runOracles(journal))).toBe(true);
  });

  it("still opens a prompt for each distinct call", () => {
    const events = sealAll([
      unsealed("agent_start", {}),
      unsealed("turn_start", {}, TURN),
      unsealed("llm_call", { request_id: "req_1" }, TURN),
      unsealed("llm_call", { request_id: "req_2" }, TURN),
      unsealed("turn_end", {}, TURN),
      unsealed("agent_stop", { session_outcome: "completed" }),
    ]);
    const prompts = projectToTrace(events).events.filter(
      (event) => event.event === "prompt_assembled",
    );
    expect(prompts).toHaveLength(2);
  });
});
