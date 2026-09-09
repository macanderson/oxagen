import { describe, expect, it } from "vitest";
import { minimalSession, sealAll, unsealed } from "../test-helpers";
import { runOracles } from "./oracles";
import { projectToTrace } from "./project";
import { reportPassed } from "./report";
import { TRACE_FORMAT } from "./types";

describe("projection onto the contextgraph-trace journal", () => {
  it("projects a complete session that passes the oracles", () => {
    const journal = projectToTrace(minimalSession());
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "prompt_assembled",
      "model_response",
      "tool_call",
      "tool_result",
      "prompt_assembled",
      "model_response",
      "turn_end",
      "session_end",
    ]);
    expect(journal.events[0]).toMatchObject({
      seq: 1,
      agent: "acme.core.cc-laptop",
      harness: "claude-code/2.1.263",
      model: "claude-haiku-4-5-20251001",
      trace_format: TRACE_FORMAT,
    });
    const report = runOracles(journal);
    expect(reportPassed(report)).toBe(true);
    expect(
      report.checks.find((c) => c.name === "turn-loop-pairing")?.evidence,
    ).toContain("1 call(s) requested");
  });

  it("records a denied tool as a rejected result with no execution", () => {
    const events = sealAll([
      unsealed("agent_start", {}),
      unsealed("turn_start", {}, { turn: { turn_seq: 1 } }),
      unsealed("llm_call", { context_window: 1000 }, { turn: { turn_seq: 1 } }),
      unsealed(
        "policy_decision",
        {
          tool_name: "Bash",
          tool_use_id: "toolu_9",
          policy_decision: "deny",
          policy_rule: "Bash(rm *)",
        },
        { turn: { turn_seq: 1 } },
      ),
      unsealed("turn_end", {}, { turn: { turn_seq: 1 } }),
      unsealed("agent_stop", { session_outcome: "completed" }),
    ]);
    const journal = projectToTrace(events);
    expect(journal.events.map((event) => event.event)).toContain("tool_result");
    expect(
      journal.events.find((event) => event.event === "tool_result"),
    ).toMatchObject({
      call_id: "toolu_9",
      status: "rejected",
    });
    expect(
      journal.events.filter((event) => event.event === "tool_call"),
    ).toHaveLength(0);
    expect(reportPassed(runOracles(journal))).toBe(true);
  });

  it("leaves a crashed session without session_end, which the oracles accept", () => {
    const events = minimalSession().slice(0, 5);
    const journal = projectToTrace(events);
    expect(journal.events.map((event) => event.event)).not.toContain(
      "session_end",
    );
    expect(reportPassed(runOracles(journal))).toBe(true);
  });

  it("emits side effects with intended-once ids and links resumes", () => {
    const events = sealAll([
      unsealed("agent_start", {}),
      unsealed("turn_start", {}, { turn: { turn_seq: 1 } }),
      unsealed("llm_call", {}, { turn: { turn_seq: 1 } }),
      unsealed(
        "tool_requested",
        { tool_name: "Write", tool_use_id: "toolu_w" },
        { turn: { turn_seq: 1 } },
      ),
      unsealed(
        "file_io",
        {
          tool_use_id: "toolu_w",
          effect_id: "eff_1",
          effect_kind: "file_write",
          tool_target: "/tmp/a",
        },
        { turn: { turn_seq: 1 } },
      ),
      unsealed(
        "tool_call",
        { tool_name: "Write", tool_use_id: "toolu_w", tool_status: "ok" },
        { turn: { turn_seq: 1 } },
      ),
      unsealed("agent_start", {
        resume_of_session_id: "prev",
        resume_last_seq_seen: 6,
      }),
      unsealed("turn_start", {}, { turn: { turn_seq: 2 } }),
      unsealed("llm_call", {}, { turn: { turn_seq: 2 } }),
      unsealed("turn_end", {}, { turn: { turn_seq: 2 } }),
      unsealed("agent_stop", { session_outcome: "aborted" }),
    ]);
    const journal = projectToTrace(events, {
      budgetTokens: 4096,
      session: "sess_custom",
    });
    const kinds = journal.events.map((event) => event.event);
    expect(kinds).toContain("side_effect");
    expect(kinds).toContain("resume");
    expect(
      journal.events.every((event) => event.session === "sess_custom"),
    ).toBe(true);
    const prompt = journal.events.find(
      (event) => event.event === "prompt_assembled",
    );
    expect(prompt).toMatchObject({ budget_tokens: 4096 });
    const report = runOracles(journal);
    expect(
      report.checks.find((c) => c.name === "effect-exactly-once")?.status,
    ).toBe("pass");
    expect(
      report.checks.find((c) => c.name === "sequence-integrity")?.status,
    ).toBe("pass");
  });
});
