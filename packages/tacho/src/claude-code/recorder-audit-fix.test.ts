/**
 * The recorder's handling of a session with subagents, and of the ways a
 * session or a turn ends: one count per call across the session and its
 * subagents, OTel records naming only a subagent type, a session that ends
 * with subagents open, the session's title, a turn ended by an API error or
 * by the person, and frames that arrive after a chain stopped.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { digestBytes } from "../digest";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import { TURN_END_REASON_ATTR } from "./hooks";
import { LLM_CALL_DUPLICATE_OF_ATTR } from "./llm-call-dedupe";
import {
  AFTER_STOP_ATTR,
  SessionRecorder,
  SUBAGENT_TYPE_AMBIGUOUS_ATTR,
} from "./recorder";
import { TOOL_CALL_DUPLICATE_OF_ATTR } from "./tool-call-dedupe";
import { normalizeTranscriptLine } from "./transcript";

const ID = "11111111-2222-3333-4444-777777777777";
const SCOPE = "host-audit-fix-test";
const at = "2026-09-21T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
  now: () => Date.parse(at),
};

function kv(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function nanos(iso: string): string {
  return (BigInt(Date.parse(iso)) * 1_000_000n).toString();
}

/** One OTel log record, as Claude Code posts it: no `agent_id`, ever. */
function otelLog(
  name: string,
  attributes: Array<ReturnType<typeof kv>>,
  ts = at,
) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv("os.type", "linux")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: nanos(ts),
                body: { stringValue: `claude_code.${name}` },
                attributes: [kv("session.id", ID), ...attributes],
              },
            ],
          },
        ],
      },
    ],
  };
}

function apiRequest(requestId: string, agentName?: string, ts = at) {
  return otelLog(
    "api_request",
    [
      kv("model", "claude-haiku-4-5"),
      kv("request_id", requestId),
      kv("input_tokens", "10"),
      kv("output_tokens", "5"),
      ...(agentName !== undefined ? [kv("agent.name", agentName)] : []),
    ],
    ts,
  );
}

function toolResult(toolUseId: string) {
  return otelLog("tool_result", [
    kv("tool_name", "Bash"),
    kv("tool_use_id", toolUseId),
    kv("success", "true"),
  ]);
}

function assistantLine(requestId: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at,
    requestId,
    message: {
      id: `msg_${requestId}`,
      model: "claude-haiku-4-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "ok" }],
    },
  });
}

function hook(
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { session_id: ID, hook_event_name: name, ...extra };
}

function toolHook(
  name: "PreToolUse" | "PostToolUse",
  toolUseId: string,
  agentId?: string,
): Record<string, unknown> {
  return hook(name, {
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "ls" },
    ...(name === "PostToolUse" ? { tool_response: { stdout: "x" } } : {}),
    ...(agentId !== undefined
      ? { agent_id: agentId, agent_type: "Explore" }
      : {}),
  });
}

function started(): SessionRecorder {
  const chain = new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: SCOPE,
  });
  chain.ingestHook(hook("SessionStart"), {}, at);
  return chain;
}

function spawn(chain: SessionRecorder, agentId: string, when = at): void {
  chain.ingestHook(
    hook("SubagentStart", { agent_id: agentId, agent_type: "Explore" }),
    {},
    when,
  );
}

function childOf(chain: SessionRecorder, index = 0) {
  return chain.snapshot().children[index];
}

function bodyOf(event: TachoEvent | undefined): Record<string, unknown> {
  return (event?.body ?? {}) as Record<string, unknown>;
}

function ofKind(events: readonly TachoEvent[], kind: string): TachoEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe("a subagent's call reported on two chains", () => {
  it("seals its tool call once, on the subagent's chain", () => {
    const chain = started();
    spawn(chain, "a");
    chain.ingestHook(toolHook("PostToolUse", "toolu_sub", "a"), {}, at);
    chain.ingestOtlp(toolResult("toolu_sub"));
    expect(ofKind(chain.sealedEvents, "tool_call")).toHaveLength(0);
    expect(ofKind(childOf(chain)?.events ?? [], "tool_call")).toHaveLength(1);
  });

  it("routes an OTel result that beats the hook to the subagent that asked", () => {
    const chain = started();
    spawn(chain, "a");
    chain.ingestHook(toolHook("PreToolUse", "toolu_sub", "a"), {}, at);
    chain.ingestOtlp(toolResult("toolu_sub"));
    chain.ingestHook(toolHook("PostToolUse", "toolu_sub", "a"), {}, at);
    expect(ofKind(chain.sealedEvents, "tool_call")).toHaveLength(0);
    const calls = ofKind(childOf(chain)?.events ?? [], "tool_call");
    expect(calls.map((call) => call.source)).toEqual(["otel_log", "hook"]);
    expect(calls[1]?.attrs[TOOL_CALL_DUPLICATE_OF_ATTR]).toBe("otel_log");
  });

  it("counts a subagent's model call once when its OTel record lands on the session", () => {
    const chain = started();
    spawn(chain, "a");
    chain.ingestTranscriptLine(assistantLine("req_sub"), "a");
    chain.ingestOtlp(apiRequest("req_sub"));
    const root = ofKind(chain.sealedEvents, "llm_call");
    expect(root).toHaveLength(1);
    expect(root[0]?.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("transcript");
    const child = ofKind(childOf(chain)?.events ?? [], "llm_call");
    expect(child[0]?.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBeUndefined();
  });

  it("counts a proxied subagent call once when the subagent's transcript reports it", () => {
    const chain = started();
    spawn(chain, "a");
    chain.sealCollectorEvent(
      "llm_call",
      { model: "claude-haiku-4-5", request_id: "req_proxy", input_tokens: 10 },
      { fidelity: "proxy" },
    );
    chain.ingestTranscriptLine(assistantLine("req_proxy"), "a");
    const child = ofKind(childOf(chain)?.events ?? [], "llm_call");
    expect(child[0]?.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("collector");
  });

  it("keeps one ledger for the family across a restart", () => {
    const chain = started();
    spawn(chain, "a");
    chain.ingestTranscriptLine(assistantLine("req_sub"), "a");
    chain.ingestHook(toolHook("PostToolUse", "toolu_sub", "a"), {}, at);
    const state = chain.state();
    expect(state.children["a"]?.state.llmCalls?.keys).toEqual([]);
    const resumed = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: state,
    });
    resumed.ingestOtlp(apiRequest("req_sub"));
    resumed.ingestOtlp(toolResult("toolu_sub"));
    const llm = ofKind(resumed.sealedEvents, "llm_call");
    expect(llm[0]?.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("transcript");
    expect(ofKind(resumed.sealedEvents, "tool_call")).toHaveLength(0);
  });

  it("takes on the calls a state written with a ledger per chain kept on the subagent", () => {
    const chain = started();
    spawn(chain, "a");
    const state = chain.state();
    const child = state.children["a"];
    if (child === undefined) throw new Error("no child state");
    child.state.llmCalls = {
      keys: [["request:req_old", ["transcript"], true]],
    };
    child.state.toolCalls = { calls: [["toolu_old", ["hook"], true]] };
    const resumed = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: state,
    });
    resumed.ingestOtlp(apiRequest("req_old"));
    resumed.ingestOtlp(toolResult("toolu_old"));
    expect(
      ofKind(resumed.sealedEvents, "llm_call")[0]?.attrs[
        LLM_CALL_DUPLICATE_OF_ATTR
      ],
    ).toBe("transcript");
    expect(ofKind(resumed.sealedEvents, "tool_call")).toHaveLength(0);
  });

  it("forgets a subagent's sighting the rolled-back family never kept", () => {
    const chain = started();
    spawn(chain, "a");
    const mark = chain.markChain();
    chain.ingestHook(toolHook("PostToolUse", "toolu_sub", "a"), {}, at);
    chain.rollbackChain(mark);
    chain.ingestOtlp(toolResult("toolu_sub"));
    expect(ofKind(chain.sealedEvents, "tool_call")).toHaveLength(1);
  });
});

describe("an OTel record naming only a subagent type", () => {
  it("seals on the session, marked, when two subagents of that type are open", () => {
    const chain = started();
    spawn(chain, "a");
    spawn(chain, "b");
    chain.ingestOtlp(apiRequest("req_x", "Explore"));
    const llm = ofKind(chain.sealedEvents, "llm_call");
    expect(llm).toHaveLength(1);
    expect(llm[0]?.attrs[SUBAGENT_TYPE_AMBIGUOUS_ATTR]).toBe("1");
    for (const index of [0, 1])
      expect(ofKind(childOf(chain, index)?.events ?? [], "llm_call")).toEqual(
        [],
      );
  });

  it("goes to the one open subagent of that type", () => {
    const chain = started();
    spawn(chain, "a");
    chain.ingestOtlp(apiRequest("req_x", "Explore"));
    expect(ofKind(chain.sealedEvents, "llm_call")).toEqual([]);
    expect(ofKind(childOf(chain)?.events ?? [], "llm_call")).toHaveLength(1);
  });

  it("goes to a subagent that stopped just before it arrived, and no later", () => {
    const chain = started();
    spawn(chain, "a");
    chain.ingestHook(
      hook("SubagentStop", { agent_id: "a", agent_type: "Explore" }),
      {},
      at,
    );
    chain.ingestOtlp(
      apiRequest("req_late", "Explore", "2026-09-21T00:00:05.000Z"),
    );
    chain.ingestOtlp(
      apiRequest("req_later", "Explore", "2026-09-21T00:01:00.000Z"),
    );
    const child = ofKind(childOf(chain)?.events ?? [], "llm_call");
    expect(child.map((event) => bodyOf(event)["request_id"])).toEqual([
      "req_late",
    ]);
    expect(
      ofKind(chain.sealedEvents, "llm_call").map(
        (event) => bodyOf(event)["request_id"],
      ),
    ).toEqual(["req_later"]);
  });
});

describe("a session that ends with a subagent open", () => {
  it("closes the subagent as aborted before the session's own stop", () => {
    const chain = started();
    spawn(chain, "bg");
    const out = chain.ingestHook(
      hook("SessionEnd", { reason: "other" }),
      {},
      at,
    );
    const child = childOf(chain);
    const childStop = ofKind(child?.events ?? [], "agent_stop");
    expect(childStop).toHaveLength(1);
    expect(bodyOf(childStop[0])["session_outcome"]).toBe("aborted");
    expect(chain.openChildren.size).toBe(0);
    const kinds = out.map((event) => `${event.session_uuid}:${event.kind}`);
    expect(kinds).toEqual([
      `${child?.sessionUuid}:agent_stop`,
      `${chain.sessionUuid}:agent_stop`,
    ]);
    for (const events of [chain.sealedEvents, child?.events ?? []])
      expect(verifyChain(events).ok).toBe(true);
  });

  it("carries the transcript's totals on a clean exit", () => {
    const chain = started();
    chain.ingestTranscriptLine(
      JSON.stringify({
        type: "cost-state",
        totalCostUSD: 0.25,
        totalDuration: 9000,
        totalLinesAdded: 3,
      }),
    );
    const [stop] = chain.ingestHook(
      hook("SessionEnd", { reason: "other" }),
      {},
      at,
    );
    expect(stop?.body).toMatchObject({
      session_end_reason: "other",
      session_outcome: "completed",
      total_cost_usd_micros: 250_000,
      duration_ms: 9000,
      lines_added: 3,
      seq_count: (stop?.seq ?? 0) + 1,
    });
  });
});

describe("the session's title", () => {
  const title = (type: string, member: string, text: string) =>
    JSON.stringify({ type, [member]: text, sessionId: ID });

  it("reads a rename as the title", () => {
    expect(
      normalizeTranscriptLine(title("custom-title", "customTitle", "Mine"), at)
        .title,
    ).toEqual({ text: "Mine", source: "custom-title" });
  });

  it("seals each change, the text as content, and lets a rename outrank the generated one", () => {
    const chain = started();
    const sealed = (line: string) =>
      ofKind(chain.ingestTranscriptLine(line), "oxagen:notification");
    const [first] = sealed(title("ai-title", "aiTitle", "Fix the build"));
    expect(first?.body).toEqual({ notification_type: "session_title" });
    expect(first?.hook_source_kind).toBe("ai-title");
    expect(first?.content?.digest).toBe(digestBytes("Fix the build"));
    expect(sealed(title("ai-title", "aiTitle", "Fix the build"))).toEqual([]);
    expect(
      sealed(title("ai-title", "aiTitle", "Fix the CI build")),
    ).toHaveLength(1);
    const [rename] = sealed(title("custom-title", "customTitle", "Release"));
    expect(rename?.hook_source_kind).toBe("custom-title");
    expect(sealed(title("ai-title", "aiTitle", "Something else"))).toEqual([]);
    expect(chain.totals.session_title).toBe("Release");
    expect(JSON.stringify(chain.sealedEvents)).not.toContain("Release");
  });
});

describe("a turn no Stop closes", () => {
  it("closes on a StopFailure, with the API error as the reason", () => {
    const chain = started();
    chain.ingestHook(hook("UserPromptSubmit", { prompt: "go" }), {}, at);
    const out = chain.ingestHook(
      hook("StopFailure", {
        error_type: "rate_limit",
        last_assistant_message: "API Error: 429",
      }),
      {},
      at,
    );
    expect(out.map((event) => event.kind)).toEqual(["error", "turn_end"]);
    expect(out[1]?.attrs[TURN_END_REASON_ATTR]).toBe("api_error");
    expect(bodyOf(out[1])["stop_failure_error_type"]).toBe("rate_limit");
    const [after] = chain.ingestHook(hook("Notification"), {}, at);
    expect(after?.turn?.turn_seq).toBeUndefined();
  });

  const interrupt = (promptId: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "user",
      timestamp: at,
      promptId,
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
      ...extra,
    });

  it("closes on the person's Esc, read from the transcript", () => {
    const chain = started();
    chain.ingestHook(
      hook("UserPromptSubmit", { prompt: "go", prompt_id: "p1" }),
      {},
      at,
    );
    const out = chain.ingestTranscriptLine(interrupt("p1"));
    const end = ofKind(out, "turn_end");
    expect(end).toHaveLength(1);
    expect(end[0]?.source).toBe("collector");
    expect(end[0]?.attrs[TURN_END_REASON_ATTR]).toBe("interrupted");
    expect(end[0]?.turn?.turn_seq).toBe(1);
    expect(
      ofKind(chain.ingestTranscriptLine(interrupt("p1")), "turn_end"),
    ).toEqual([]);
  });

  it("leaves a newer turn open when the tailer reads an older interrupt late", () => {
    const chain = started();
    chain.ingestHook(
      hook("UserPromptSubmit", { prompt: "next", prompt_id: "p2" }),
      {},
      at,
    );
    expect(
      ofKind(chain.ingestTranscriptLine(interrupt("p1")), "turn_end"),
    ).toEqual([]);
  });

  it("closes on a record naming the message it interrupted", () => {
    const chain = started();
    chain.ingestHook(
      hook("UserPromptSubmit", { prompt: "go", prompt_id: "p1" }),
      {},
      at,
    );
    const line = JSON.stringify({
      type: "user",
      timestamp: at,
      promptId: "p1",
      interruptedMessageId: "msg_1",
      message: { role: "user", content: [{ type: "text", text: "stop" }] },
    });
    expect(ofKind(chain.ingestTranscriptLine(line), "turn_end")).toHaveLength(
      1,
    );
  });
});

describe("a frame after the chain stopped", () => {
  it("is sealed and marked, and the stop itself is not", () => {
    const chain = started();
    const [stop] = chain.ingestHook(hook("SessionEnd"), {}, at);
    expect(stop?.attrs[AFTER_STOP_ATTR]).toBeUndefined();
    expect(chain.isStopped).toBe(true);
    const late = chain.sealCollectorEvent("checkpoint", { checkpoint_id: "c" });
    expect(late.attrs[AFTER_STOP_ATTR]).toBe("1");
    const [otel] = chain.ingestOtlp(apiRequest("req_late"));
    expect(otel?.attrs[AFTER_STOP_ATTR]).toBe("1");
  });

  it("marks nothing the collector's own stop seals", () => {
    const chain = started();
    const [stop] = chain.finalize("crashed", at);
    expect(stop?.kind).toBe("agent_stop");
    expect(stop?.attrs[AFTER_STOP_ATTR]).toBeUndefined();
    const direct = started();
    const sealed = direct.sealCollectorEvent("agent_stop", {
      session_outcome: "completed",
    });
    expect(sealed.attrs[AFTER_STOP_ATTR]).toBeUndefined();
    expect(direct.isStopped).toBe(true);
  });

  it("is live again once the session resumes", () => {
    const chain = started();
    chain.ingestHook(hook("SessionEnd"), {}, at);
    const [resume] = chain.ingestHook(
      hook("SessionStart", { source: "resume" }),
      {},
      at,
    );
    expect(resume?.attrs[AFTER_STOP_ATTR]).toBeUndefined();
    expect(chain.isStopped).toBe(false);
    const [prompt] = chain.ingestHook(hook("UserPromptSubmit"), {}, at);
    expect(prompt?.attrs[AFTER_STOP_ATTR]).toBeUndefined();
  });
});
