/**
 * One tool call, one sealed frame.
 *
 * The hook, the OTel export and the transcript tailer each report the same
 * `tool_use_id`. What is asserted here is that the chain holds one `tool_call`
 * for it, that the frame is the one carrying the body, that a later sighting
 * that brings a body the chain does not hold is still sealed and stamped, and
 * that the ledger survives a restart and a chain rollback.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "./context";
import { SessionRecorder } from "./recorder";
import {
  TOOL_CALL_DUPLICATE_OF_ATTR,
  TOOL_CALL_LEDGER_CAPACITY,
  ToolCallLedger,
} from "./tool-call-dedupe";

const ID = "11111111-2222-3333-4444-666666666666";
const SCOPE = "host-tool-call-test";
const TOOL_USE_ID = "toolu_01witness";
const at = "2026-09-21T00:00:00.000Z";
const TS_NANOS = "1788861970750000000";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

function kv(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/** The OTel log record Claude Code posts when a tool returns. */
function otelToolResult(toolUseId: string) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv("os.type", "linux")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: TS_NANOS,
                body: { stringValue: "claude_code.tool_result" },
                attributes: [
                  kv("tool_name", "Bash"),
                  kv("tool_use_id", toolUseId),
                  kv("success", "true"),
                  kv("duration_ms", "12"),
                  kv("decision_source", "config"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** The transcript line Claude Code writes for the same result. */
function transcriptToolResult(toolUseId: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: at,
    toolUseResult: { stdout: "x" },
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId }],
    },
  });
}

/** The PostToolUse payload, which is the only source carrying the body. */
function postToolUse(toolUseId: string): Record<string, unknown> {
  return {
    session_id: ID,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: toolUseId,
    tool_input: { command: "ls" },
    tool_response: { stdout: "x" },
    duration_ms: 12,
  };
}

function recorder(): SessionRecorder {
  const made = new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: SCOPE,
  });
  made.ingestHook({ session_id: ID, hook_event_name: "SessionStart" }, {}, at);
  return made;
}

function toolCalls(chain: SessionRecorder) {
  return chain.sealedEvents.filter((event) => event.kind === "tool_call");
}

describe("a tool call reported by every source", () => {
  it("seals one frame, the one carrying the body", () => {
    const chain = recorder();
    chain.ingestHook(postToolUse(TOOL_USE_ID), {}, at);
    chain.ingestOtlp(otelToolResult(TOOL_USE_ID));
    chain.ingestTranscriptLine(transcriptToolResult(TOOL_USE_ID));
    const calls = toolCalls(chain);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("hook");
    expect(calls[0]?.content?.digest).toMatch(/^sha256:/);
  });

  it("counts two calls as two frames", () => {
    const chain = recorder();
    chain.ingestHook(postToolUse("toolu_a"), {}, at);
    chain.ingestHook(postToolUse("toolu_b"), {}, at);
    chain.ingestOtlp(otelToolResult("toolu_a"));
    chain.ingestOtlp(otelToolResult("toolu_b"));
    expect(toolCalls(chain)).toHaveLength(2);
  });

  it("seals a digest-only source when it is the only one to report", () => {
    const chain = recorder();
    chain.ingestOtlp(otelToolResult(TOOL_USE_ID));
    const calls = toolCalls(chain);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe("otel_log");
  });

  it("seals the body when a digest-only source reported the call first", () => {
    const chain = recorder();
    chain.ingestTranscriptLine(transcriptToolResult(TOOL_USE_ID));
    chain.ingestHook(postToolUse(TOOL_USE_ID), {}, at);
    chain.ingestOtlp(otelToolResult(TOOL_USE_ID));
    const calls = toolCalls(chain);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.source).toBe("hook");
    expect(calls[1]?.attrs[TOOL_CALL_DUPLICATE_OF_ATTR]).toBe("transcript");
    expect(calls[0]?.attrs[TOOL_CALL_DUPLICATE_OF_ATTR]).toBeUndefined();
  });

  it("keeps deduping a call the chain sealed before a restart", () => {
    const chain = recorder();
    chain.ingestHook(postToolUse(TOOL_USE_ID), {}, at);
    const resumed = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: chain.state(),
    });
    resumed.ingestOtlp(otelToolResult(TOOL_USE_ID));
    resumed.ingestTranscriptLine(transcriptToolResult(TOOL_USE_ID));
    expect(toolCalls(resumed)).toHaveLength(0);
  });

  it("forgets a sighting the rolled-back chain never kept", () => {
    const chain = recorder();
    const mark = chain.markChain();
    chain.ingestHook(postToolUse(TOOL_USE_ID), {}, at);
    chain.rollbackChain(mark);
    chain.ingestHook(postToolUse(TOOL_USE_ID), {}, at);
    expect(toolCalls(chain)).toHaveLength(1);
  });

  it("routes a subagent's call to its own chain", () => {
    const chain = recorder();
    chain.ingestHook(
      {
        session_id: ID,
        hook_event_name: "SubagentStart",
        agent_id: "child",
        agent_type: "reviewer",
      },
      {},
      at,
    );
    chain.ingestHook(postToolUse(TOOL_USE_ID), {}, at);
    chain.ingestHook(
      { ...postToolUse(TOOL_USE_ID), agent_id: "child" },
      {},
      at,
    );
    expect(toolCalls(chain)).toHaveLength(1);
    const child = [...chain.openChildren.values()][0];
    expect(child).toBeDefined();
    expect(child === undefined ? [] : toolCalls(child)).toHaveLength(1);
  });
});

describe("the tool-call ledger", () => {
  it("judges a row with no tool use id a first sighting every time", () => {
    const ledger = new ToolCallLedger();
    for (const _ of [0, 1, 2]) {
      const sighting = ledger.judge(undefined, "collector", false);
      sighting.commit();
      expect(sighting.verdict).toEqual({ kind: "first" });
    }
    expect(ledger.state().calls).toEqual([]);
  });

  it("registers nothing until the row that carries the verdict lands", () => {
    const ledger = new ToolCallLedger();
    ledger.judge(TOOL_USE_ID, "hook", true);
    expect(ledger.judge(TOOL_USE_ID, "otel_log", false).verdict).toEqual({
      kind: "first",
    });
  });

  it("forgets the oldest call once it is full", () => {
    const ledger = new ToolCallLedger();
    for (let index = 0; index <= TOOL_CALL_LEDGER_CAPACITY; index += 1)
      ledger.judge(`toolu_${String(index)}`, "hook", true).commit();
    expect(ledger.state().calls).toHaveLength(TOOL_CALL_LEDGER_CAPACITY);
    expect(ledger.judge("toolu_0", "hook", true).verdict).toEqual({
      kind: "first",
    });
    expect(ledger.judge("toolu_1", "otel_log", false).verdict).toEqual({
      kind: "repeat",
    });
  });
});
