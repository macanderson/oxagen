import { describe, expect, it } from "vitest";
import { TOOL_CALL_DUPLICATE_OF_ATTR } from "../claude-code/tool-call-dedupe";
import type { BodyOf } from "../envelope";
import { minimalSession, sealAll, unsealed } from "../test-helpers";
import type { Journal } from "./journal";
import { CHECK_RESUME, runOracles } from "./oracles";
import { projectToTrace } from "./project";
import { reportPassed } from "./report";
import { TRACE_FORMAT } from "./types";

const TURN = { turn: { turn_seq: 1 } };

/** Each check the journal fails, with its evidence, so a failure says why. */
function failures(journal: Journal): string[] {
  return runOracles(journal)
    .checks.filter((check) => check.status === "fail")
    .map((check) => `${check.name}: ${check.evidence}`);
}

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

describe("a call more than one frame answers", () => {
  it("answers a call Oxagen refused once, though its verdict and the refused request both deny it", () => {
    const deny = {
      tool_name: "Bash",
      tool_use_id: "toolu_d",
      policy_decision: "deny",
    } as const;
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("llm_call", { context_window: 1000 }, TURN),
        unsealed("policy_decision", deny, { ...TURN, source: "collector" }),
        unsealed("token_denied", deny, TURN),
        unsealed("turn_end", {}, TURN),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "prompt_assembled",
      "model_response",
      "tool_result",
      "turn_end",
      "session_end",
    ]);
    expect(failures(journal)).toEqual([]);
  });

  it("takes back the execution of a call the harness refused after its request", () => {
    const deny = {
      tool_name: "Bash",
      tool_use_id: "toolu_h",
      policy_decision: "deny",
    } as const;
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("llm_call", { context_window: 1000 }, TURN),
        unsealed(
          "tool_requested",
          { tool_name: "Bash", tool_use_id: "toolu_h" },
          TURN,
        ),
        // PermissionDenied, then the same refusal from OTel.
        unsealed("harness_permission", deny, TURN),
        unsealed("harness_permission", deny, { ...TURN, source: "otel_log" }),
        unsealed("turn_end", {}, TURN),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "prompt_assembled",
      "model_response",
      "tool_result",
      "turn_end",
      "session_end",
    ]);
    expect(
      journal.events.find((event) => event.event === "tool_result"),
    ).toMatchObject({ call_id: "toolu_h", status: "rejected" });
    expect(failures(journal)).toEqual([]);
  });

  it("writes one result for a call a second source reports with its body", () => {
    const call = {
      tool_name: "Read",
      tool_use_id: "toolu_r",
      tool_status: "ok",
    } as const;
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed(
          "tool_requested",
          { tool_name: "Read", tool_use_id: "toolu_r" },
          TURN,
        ),
        unsealed("tool_call", call, { ...TURN, source: "collector" }),
        unsealed("tool_call", call, {
          ...TURN,
          attrs: { [TOOL_CALL_DUPLICATE_OF_ATTR]: "gateway" },
        }),
        unsealed("turn_end", {}, TURN),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    expect(
      journal.events.filter((event) => event.event === "tool_result"),
    ).toHaveLength(1);
    expect(failures(journal)).toEqual([]);
  });
});

describe("a session that starts again on its own chain", () => {
  const read = { tool_name: "Read", tool_use_id: "toolu_1" } as const;
  const SECOND = { turn: { turn_seq: 2 } };

  it("says a resume recovered through the journal line before it", () => {
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("llm_call", {}, TURN),
        unsealed("tool_requested", read, TURN),
        unsealed("tool_call", { ...read, tool_status: "ok" }, TURN),
        unsealed("turn_end", {}, TURN),
        // Tacho seq 5 is the turn_end above, which is journal line 7.
        unsealed("agent_start", {
          session_start_source: "resume",
          resume_of_session_id: "s",
          resume_last_seq_seen: 5,
        }),
        unsealed("turn_start", {}, SECOND),
        unsealed("turn_end", {}, SECOND),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    const resume = journal.events.find((event) => event.event === "resume");
    expect(resume).toMatchObject({ seq: 8, last_seq_seen: 7 });
    const check = runOracles(journal).checks.find(
      (c) => c.name === CHECK_RESUME,
    );
    expect(check?.status).toBe("pass");
    expect(failures(journal)).toEqual([]);
  });

  it("drops the session_end of a session that a resume reopens", () => {
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("turn_end", {}, TURN),
        unsealed("agent_stop", { session_outcome: "completed" }),
        unsealed("agent_start", {
          session_start_source: "resume",
          resume_of_session_id: "s",
          resume_last_seq_seen: 3,
        }),
        unsealed("turn_start", {}, SECOND),
        unsealed("turn_end", {}, SECOND),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "turn_end",
      "resume",
      "turn_start",
      "turn_end",
      "session_end",
    ]);
    expect(journal.events[3]).toMatchObject({ seq: 4, last_seq_seen: 3 });
    expect(failures(journal)).toEqual([]);
  });

  // A host before 2026-10-03 sealed a compaction's start with resume members.
  const compactions: Array<[string, BodyOf<"agent_start">]> = [
    ["as a host seals it now", { session_start_source: "compact" }],
    [
      "as an older host sealed it",
      {
        session_start_source: "compact",
        resume_of_session_id: "s",
        resume_last_seq_seen: 2,
      },
    ],
  ];

  it.each(compactions)("keeps a turn going over a compaction %s", (_, start) => {
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("llm_call", {}, TURN),
        unsealed("agent_start", start),
        unsealed("llm_call", {}, TURN),
        unsealed("tool_requested", read, TURN),
        unsealed("tool_call", { ...read, tool_status: "ok" }, TURN),
        unsealed("turn_end", {}, TURN),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    const kinds = journal.events.map((event) => event.event);
    expect(kinds).not.toContain("resume");
    expect(kinds.filter((kind) => kind === "session_start")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "prompt_assembled")).toHaveLength(2);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(failures(journal)).toEqual([]);
  });
});

describe("a turn the daemon sent on after its Stop", () => {
  const read = { tool_name: "Read", tool_use_id: "toolu_s" } as const;

  it("ends at the turn's last turn_end and keeps the work between", () => {
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("llm_call", {}, TURN),
        // The Stop the daemon answered with decision "block".
        unsealed("turn_end", {}, TURN),
        // The model call that followed, sealed before a hook opened the turn
        // again, so it carries the prompt and no turn number.
        unsealed("llm_call", {}, { turn: { prompt_id: "p1" } }),
        unsealed("tool_requested", read, TURN),
        unsealed("tool_call", { ...read, tool_status: "ok" }, TURN),
        unsealed("turn_end", { stop_hook_active: true }, TURN),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "prompt_assembled",
      "model_response",
      "prompt_assembled",
      "model_response",
      "tool_call",
      "tool_result",
      "turn_end",
      "session_end",
    ]);
    expect(failures(journal)).toEqual([]);
  });

  it("ends a turn at a turn_end that no later frame of the turn follows", () => {
    // An older host sealed the work after a blocked Stop with no turn number,
    // so the turn reads as it always did: closed at the first Stop.
    const journal = projectToTrace(
      sealAll([
        unsealed("agent_start", {}),
        unsealed("turn_start", {}, TURN),
        unsealed("turn_end", {}, TURN),
        unsealed("tool_requested", read),
        unsealed("turn_end", { stop_hook_active: true }),
        unsealed("agent_stop", { session_outcome: "completed" }),
      ]),
    );
    expect(journal.events.map((event) => event.event)).toEqual([
      "session_start",
      "turn_start",
      "turn_end",
      "session_end",
    ]);
    expect(failures(journal)).toEqual([]);
  });
});
