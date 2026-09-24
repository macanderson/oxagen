/**
 * One subagent call, one counted row across the session family.
 *
 * A subagent's model call reaches the collector from sources that land on
 * different chains. The loopback proxy correlates by the harness session id,
 * which a subagent shares with its parent, so it seals on the root chain.
 * OTel routes by `agent_id` and the finished subagent transcript is fed to
 * the child chain. Each chain used to keep its own dedupe ledger, so the root
 * and the child each counted the same call as a first sighting.
 *
 * The second half is attribution: an OTel record that names only the
 * subagent type must not be filed on one of two parallel subagents of that
 * type as though it were known to be that one's.
 */
import { describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import type { ClaudeCodeContext } from "./context";
import { countsLlmCallUsage } from "./llm-call-dedupe";
import { SessionRecorder } from "./recorder";
import { TOOL_CALL_DUPLICATE_OF_ATTR } from "./tool-call-dedupe";

const ID = "11111111-2222-3333-4444-777777777777";
const SCOPE = "host-subagent-count-test";
const at = "2026-09-24T00:00:00.000Z";
const TS_NANOS = "1790208000000000000";
const MODEL = "claude-haiku-4-5-20251001";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

/** Two subagents of one type, running at once, and the call each makes. */
const SUBAGENTS = [
  { id: "agent-a", request: "req_a", message: "msg_a", tool: "toolu_a" },
  { id: "agent-b", request: "req_b", message: "msg_b", tool: "toolu_b" },
] as const;

function kv(key: string, value: string | number) {
  return typeof value === "number"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };
}

function otelLog(name: string, attrs: Record<string, string | number>) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv("os.type", "linux")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: TS_NANOS,
                body: { stringValue: `claude_code.${name}` },
                attributes: Object.entries(attrs).map(([k, v]) => kv(k, v)),
              },
            ],
          },
        ],
      },
    ],
  };
}

function usage(request: string) {
  return {
    model: MODEL,
    input_tokens: 10,
    output_tokens: 5,
    request_id: request,
  };
}

/** The assistant record the subagent's own transcript holds for its call. */
function transcriptReply(request: string, message: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${message}`,
    requestId: request,
    timestamp: at,
    message: {
      model: MODEL,
      id: message,
      content: [{ type: "text", text: "done" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function parentWithTwoSubagents(): SessionRecorder {
  const root = new SessionRecorder({
    context,
    harnessSessionId: ID,
    scope: SCOPE,
  });
  root.ingestHook({ session_id: ID, hook_event_name: "SessionStart" }, {}, at);
  for (const sub of SUBAGENTS) {
    root.ingestHook(
      {
        session_id: ID,
        hook_event_name: "SubagentStart",
        agent_id: sub.id,
        agent_type: "Explore",
      },
      {},
      at,
    );
  }
  return root;
}

function chainOf(root: SessionRecorder, id: string): SessionRecorder {
  const child = root.openChildren.get(id);
  if (child === undefined) throw new Error(`no chain for ${id}`);
  return child;
}

function family(root: SessionRecorder): TachoEvent[] {
  return [
    ...root.sealedEvents,
    ...[...root.openChildren.values()].flatMap((c) => c.sealedEvents),
  ];
}

/** One member of an event's body, whatever the kind's body type. */
function field(event: TachoEvent, key: string): unknown {
  return (event.body as Record<string, unknown>)[key];
}

function countedCalls(events: readonly TachoEvent[]): TachoEvent[] {
  return events.filter(countsLlmCallUsage);
}

function countedTools(events: readonly TachoEvent[]): TachoEvent[] {
  return events.filter(
    (event) =>
      event.kind === "tool_call" &&
      event.attrs[TOOL_CALL_DUPLICATE_OF_ATTR] === undefined,
  );
}

describe("two parallel subagents under one parent", () => {
  it("counts each model call once when OTel and the transcript both report it", () => {
    const root = parentWithTwoSubagents();
    for (const sub of SUBAGENTS) {
      root.ingestOtlp(
        otelLog("api_request", { ...usage(sub.request), agent_id: sub.id }),
      );
      root.ingestTranscriptLine(
        transcriptReply(sub.request, sub.message),
        sub.id,
      );
    }
    for (const sub of SUBAGENTS) {
      const counted = countedCalls(chainOf(root, sub.id).sealedEvents);
      expect(counted.map((event) => field(event, "request_id"))).toEqual([
        sub.request,
      ]);
    }
    expect(countedCalls(family(root))).toHaveLength(2);
  });

  it("counts a proxied subagent call once across the root and child chains", () => {
    const root = parentWithTwoSubagents();
    for (const sub of SUBAGENTS) {
      // The proxy knows the session, not the subagent: it seals on the root.
      root.sealCollectorEvent(
        "llm_call",
        { provider: "anthropic", ...usage(sub.request) },
        { fidelity: "proxy" },
      );
      root.ingestOtlp(
        otelLog("api_request", { ...usage(sub.request), agent_id: sub.id }),
      );
      root.ingestTranscriptLine(
        transcriptReply(sub.request, sub.message),
        sub.id,
      );
    }
    const counted = countedCalls(family(root));
    expect(counted.map((event) => field(event, "request_id")).sort()).toEqual([
      "req_a",
      "req_b",
    ]);
    // The child rows stay on the child chains, stamped as later sightings.
    for (const sub of SUBAGENTS) {
      const rows = chainOf(root, sub.id).sealedEvents.filter(
        (event) => event.kind === "llm_call",
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(row.attrs["oxagen.llm_call_duplicate_of"]).toBe("collector");
    }
  });

  it("counts a subagent tool call once when its hook and a root-filed OTel record both report it", () => {
    const root = parentWithTwoSubagents();
    for (const sub of SUBAGENTS) {
      root.ingestHook(
        {
          session_id: ID,
          hook_event_name: "PostToolUse",
          agent_id: sub.id,
          agent_type: "Explore",
          tool_name: "Read",
          tool_use_id: sub.tool,
          tool_input: { file_path: "/p/a.ts" },
          tool_response: { ok: true },
        },
        {},
        at,
      );
      // No `agent_id` on the record. The hook named the call first, so it
      // routes to that subagent's chain.
      root.ingestOtlp(
        otelLog("tool_result", {
          tool_name: "Read",
          tool_use_id: sub.tool,
          success: "true",
        }),
      );
    }
    const counted = countedTools(family(root));
    expect(counted.map((event) => field(event, "tool_use_id")).sort()).toEqual([
      "toolu_a",
      "toolu_b",
    ]);
    for (const sub of SUBAGENTS) {
      expect(
        countedTools(chainOf(root, sub.id).sealedEvents).map((event) =>
          field(event, "tool_use_id"),
        ),
      ).toEqual([sub.tool]);
    }
  });

  it("does not file a record that names only the shared type on either subagent", () => {
    const root = parentWithTwoSubagents();
    root.ingestOtlp(
      otelLog("api_request", {
        ...usage("req_typed"),
        "agent.name": "Explore",
      }),
    );
    for (const sub of SUBAGENTS) {
      const rows = chainOf(root, sub.id).sealedEvents.filter(
        (event) => event.kind === "llm_call",
      );
      expect(rows).toEqual([]);
    }
    expect(
      countedCalls(root.sealedEvents).map((event) =>
        field(event, "request_id"),
      ),
    ).toEqual(["req_typed"]);
  });

  it("files a record that names only the type on the one subagent of it still open", () => {
    const root = parentWithTwoSubagents();
    const [a, b] = SUBAGENTS;
    const stopped = chainOf(root, a.id);
    root.ingestHook(
      {
        session_id: ID,
        hook_event_name: "SubagentStop",
        agent_id: a.id,
        agent_type: "Explore",
      },
      {},
      at,
    );
    root.ingestOtlp(
      otelLog("api_request", {
        ...usage("req_typed"),
        "agent.name": "Explore",
      }),
    );
    expect(
      countedCalls(chainOf(root, b.id).sealedEvents).map((event) =>
        field(event, "request_id"),
      ),
    ).toEqual(["req_typed"]);
    expect(stopped.sealedEvents.filter((e) => e.kind === "llm_call")).toEqual(
      [],
    );
    expect(countedCalls(root.sealedEvents)).toEqual([]);
  });

  it("keeps the family ledger when a rollback from the root undoes a child's call", () => {
    const root = parentWithTwoSubagents();
    const [a, b] = SUBAGENTS;
    root.ingestOtlp(
      otelLog("api_request", { ...usage(a.request), agent_id: a.id }),
    );
    const mark = root.markChain();
    root.ingestOtlp(
      otelLog("api_request", { ...usage(b.request), agent_id: b.id }),
    );
    root.rollbackChain(mark);
    // The undone call was never written, so its retry is a first sighting;
    // the call sealed before the mark is still known to the whole family.
    root.ingestOtlp(
      otelLog("api_request", { ...usage(b.request), agent_id: b.id }),
    );
    root.sealCollectorEvent(
      "llm_call",
      { provider: "anthropic", ...usage(a.request) },
      { fidelity: "proxy" },
    );
    expect(
      countedCalls(family(root))
        .map((event) => field(event, "request_id"))
        .sort(),
    ).toEqual(["req_a", "req_b"]);
  });

  it("carries the family ledger over a restart", () => {
    const before = parentWithTwoSubagents();
    const [a] = SUBAGENTS;
    before.ingestOtlp(
      otelLog("api_request", { ...usage(a.request), agent_id: a.id }),
    );
    const restored = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: before.state(),
    });
    restored.sealCollectorEvent(
      "llm_call",
      { provider: "anthropic", ...usage(a.request) },
      { fidelity: "proxy" },
    );
    expect(countedCalls(restored.sealedEvents)).toEqual([]);
  });
});

/** A call with its own token counts, so a sum shows which rows counted. */
interface Call {
  request: string;
  message: string;
  input: number;
  output: number;
}

const PARENT_CALL: Call = {
  request: "req_parent",
  message: "msg_parent",
  input: 11,
  output: 101,
};
const CALL_A: Call = {
  request: "req_a",
  message: "msg_a",
  input: 22,
  output: 202,
};
const CALL_B: Call = {
  request: "req_b",
  message: "msg_b",
  input: 33,
  output: 303,
};

function callUsage(call: Call) {
  return {
    model: MODEL,
    input_tokens: call.input,
    output_tokens: call.output,
    request_id: call.request,
  };
}

/**
 * The call as its transcript writes it: one `assistant` record per content
 * block, each carrying the whole message's usage.
 */
function transcriptBlocks(
  root: SessionRecorder,
  call: Call,
  subagentId?: string,
): void {
  for (const block of [0, 1]) {
    root.ingestTranscriptLine(
      JSON.stringify({
        type: "assistant",
        uuid: `u-${call.message}-${block}`,
        requestId: call.request,
        apiBlockIndex: block,
        timestamp: at,
        message: {
          model: MODEL,
          id: call.message,
          content: [{ type: "text", text: `block ${block}` }],
          usage: {
            input_tokens: call.input,
            output_tokens: call.output,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      subagentId,
    );
  }
}

/** The counted rows per request id, and the tokens they add up to. */
function tally(root: SessionRecorder): {
  rows: Record<string, number>;
  input: number;
  output: number;
} {
  const rows: Record<string, number> = {};
  let input = 0;
  let output = 0;
  for (const event of countedCalls(family(root))) {
    const key = String(field(event, "request_id"));
    rows[key] = (rows[key] ?? 0) + 1;
    input += Number(field(event, "input_tokens") ?? 0);
    output += Number(field(event, "output_tokens") ?? 0);
  }
  return { rows, input, output };
}

const ONCE = {
  rows: { req_parent: 1, req_a: 1, req_b: 1 },
  input: PARENT_CALL.input + CALL_A.input + CALL_B.input,
  output: PARENT_CALL.output + CALL_A.output + CALL_B.output,
};

describe("the tokens a session family counts", () => {
  it("adds each call once when the proxy, OTel by type, and split transcripts all report it", () => {
    const root = parentWithTwoSubagents();
    for (const call of [PARENT_CALL, CALL_A, CALL_B]) {
      root.sealCollectorEvent(
        "llm_call",
        { provider: "anthropic", ...callUsage(call) },
        { fidelity: "proxy" },
      );
    }
    root.ingestOtlp(otelLog("api_request", callUsage(PARENT_CALL)));
    for (const call of [CALL_A, CALL_B]) {
      root.ingestOtlp(
        otelLog("api_request", { ...callUsage(call), "agent.name": "Explore" }),
      );
    }
    transcriptBlocks(root, PARENT_CALL);
    transcriptBlocks(root, CALL_A, "agent-a");
    transcriptBlocks(root, CALL_B, "agent-b");
    expect(tally(root)).toEqual(ONCE);
  });

  it("adds each call once without the proxy, whichever chain reports it first", () => {
    const root = parentWithTwoSubagents();
    root.ingestOtlp(
      otelLog("api_request", { ...callUsage(CALL_A), "agent.name": "Explore" }),
    );
    transcriptBlocks(root, CALL_B, "agent-b");
    transcriptBlocks(root, CALL_A, "agent-a");
    root.ingestOtlp(
      otelLog("api_request", { ...callUsage(CALL_B), "agent.name": "Explore" }),
    );
    root.ingestOtlp(otelLog("api_request", callUsage(PARENT_CALL)));
    transcriptBlocks(root, PARENT_CALL);
    expect(tally(root)).toEqual(ONCE);
  });

  it("moves the calls an older build's subagent ledgers held to the family on a restart", () => {
    const before = parentWithTwoSubagents();
    transcriptBlocks(before, CALL_A, "agent-a");
    before.ingestHook(
      {
        session_id: ID,
        hook_event_name: "PostToolUse",
        agent_id: "agent-a",
        agent_type: "Explore",
        tool_name: "Read",
        tool_use_id: "toolu_a",
        tool_input: { file_path: "/p/a.ts" },
        tool_response: { ok: true },
      },
      {},
      at,
    );
    // The state file an older build wrote: the child kept its own ledgers,
    // and the root's never heard of the child's calls.
    const state = before.state();
    const child = state.children["agent-a"]?.state;
    if (child === undefined) throw new Error("no agent-a state");
    child.llmCalls = state.llmCalls;
    child.toolCalls = state.toolCalls;
    state.llmCalls = { keys: [] };
    state.toolCalls = { calls: [] };
    const after = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: state,
    });
    after.ingestOtlp(otelLog("api_request", callUsage(CALL_A)));
    after.ingestOtlp(
      otelLog("tool_result", {
        tool_name: "Read",
        tool_use_id: "toolu_a",
        success: "true",
      }),
    );
    expect(countedCalls(after.sealedEvents)).toEqual([]);
    expect(countedTools(after.sealedEvents)).toEqual([]);
  });
});
