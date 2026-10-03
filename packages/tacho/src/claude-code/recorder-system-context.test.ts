/**
 * The token sources and the system context on the recorder's model-call
 * frames (#4493), sealed through `sealCollectorEvent` the way the loopback
 * proxy seals them: which members a proxied call carries, where its steering
 * comes from, when a turn lists its parts, and what a rollback or a restart
 * keeps. The last block covers a call the proxy did not carry, which reaches
 * the chain as an OTel or transcript record and never shows its request.
 */
import { describe, expect, it } from "vitest";
import { jcs } from "../digest";
import type { TachoEvent } from "../envelope";
import { type DraftContent, jsonContent } from "../evidence/frame-body";
import type { ClaudeCodeContext } from "./context";
import {
  countsLlmCallUsage,
  LLM_CALL_DUPLICATE_OF_ATTR,
} from "./llm-call-dedupe";
import { SessionRecorder } from "./recorder";

const ID = "4493aaaa-2222-3333-4444-555555555555";
const SCOPE = "host-system-context-test";
const at = "2026-09-26T00:00:00.000Z";
const context: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.claude-code",
    fleet_id: "wrk_test",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
  },
};

const REQUEST = JSON.stringify({
  model: "claude-opus-4-5",
  max_tokens: 1024,
  system: "You are Claude Code, Anthropic's official CLI for Claude.",
  tools: [
    {
      name: "Read",
      description: "Read a file from the local filesystem.",
      input_schema: { type: "object" },
    },
    {
      name: "mcp__oxagen__search",
      description: "Search the workspace graph.",
      input_schema: { type: "object" },
    },
  ],
  messages: [{ role: "user", content: "What does recorder.ts do?" }],
});

/**
 * A side call as Claude Code sends one, such as a session title: a short
 * prompt of its own and no tools.
 */
const SIDE_REQUEST = JSON.stringify({
  model: "claude-haiku-4-5",
  max_tokens: 512,
  system: "Write a title of five words or fewer for this coding session.",
  messages: [{ role: "user", content: "What does recorder.ts do?" }],
});

const MANIFEST = {
  items: [
    {
      id: "no-force-push",
      kind: "record",
      force: "must",
      recorded_at: "2026-09-20T00:00:00.000Z",
      tokens: 40,
      outcome: "included",
    },
    {
      id: "old-style-guide",
      kind: "record",
      force: "should",
      recorded_at: "2026-09-01T00:00:00.000Z",
      tokens: 900,
      outcome: "cut",
    },
  ],
  included: 1,
  cut: 1,
};

function exchange(request = REQUEST): DraftContent {
  return jsonContent(jcs({ request, response: '{"type":"message"}' }));
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

function body(event: TachoEvent): Record<string, unknown> {
  return event.body as Record<string, unknown>;
}

/** One proxied model call with its exchange body. */
function call(
  chain: SessionRecorder,
  own: Record<string, unknown> = {},
  request = REQUEST,
): TachoEvent {
  return chain.sealCollectorEvent(
    "llm_call",
    { provider: "anthropic", model: "claude-opus-4-5", ...own },
    { fidelity: "proxy", content: exchange(request) },
  );
}

type Part = { kind: string; name: string; tokens: number };

function parts(event: TachoEvent): Part[] | undefined {
  return body(event)["system_context_parts"] as Part[] | undefined;
}

describe("a proxied model call's token sources", () => {
  it("carries the tool definition count and the system context digests", () => {
    const event = call(recorder());
    const fields = body(event);
    expect(fields["tool_definition_tokens"]).toEqual(expect.any(Number));
    expect(fields["tool_definition_tokens"]).toBeGreaterThan(0);
    expect(fields["tool_definition_tokens_basis"]).toBe("estimated");
    expect(fields["system_context_digest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(parts(event)?.map((part) => [part.kind, part.name])).toEqual([
      ["system", "system"],
      ["tool", "Read"],
      ["tool", "mcp__oxagen__search"],
    ]);
    // Claude Code's hook context rides the conversation (ADR-200), and no
    // manifest sealed, so neither source has a count.
    expect(fields).not.toHaveProperty("context_frame_tokens");
    expect(fields).not.toHaveProperty("steering_tokens");
  });

  it("takes the steering count from the session's steering manifest", () => {
    const chain = recorder();
    chain.sealCollectorEvent("steering.manifest", MANIFEST, {
      hook_event_name: "SessionStart",
    });
    const event = call(chain);
    expect(body(event)["steering_tokens"]).toBe(40);
    expect(body(event)["steering_tokens_basis"]).toBe("estimated");
    expect(parts(event)?.at(-1)).toMatchObject({
      kind: "steering",
      name: "no-force-push",
      tokens: 40,
    });
  });

  it("counts no steering on a side call, whose request declares no tools", () => {
    const chain = withManifest();
    const main = call(chain);
    const side = call(chain, { model: "claude-haiku-4-5" }, SIDE_REQUEST);
    expect(body(main)["steering_tokens"]).toBe(40);
    expect(body(side)).not.toHaveProperty("steering_tokens");
    expect(body(side)).not.toHaveProperty("steering_tokens_basis");
    // The request still shows its own system context, with no steering in it.
    expect(body(side)["tool_definition_tokens"]).toBe(0);
    expect(body(side)["system_context_digest"]).toMatch(/^sha256:/);
    expect(parts(side)?.map((part) => [part.kind, part.name])).toEqual([
      ["system", "system"],
    ]);
  });

  it("keeps a member the producer set itself", () => {
    const event = call(recorder(), {
      tool_definition_tokens: 7,
      tool_definition_tokens_basis: "reported",
    });
    expect(body(event)["tool_definition_tokens"]).toBe(7);
    expect(body(event)["tool_definition_tokens_basis"]).toBe("reported");
    expect(body(event)["system_context_digest"]).toMatch(/^sha256:/);
  });

  it("adds nothing to a call with no recorded request", () => {
    const event = recorder().sealCollectorEvent(
      "llm_call",
      { provider: "anthropic", model: "claude-opus-4-5" },
      { fidelity: "proxy" },
    );
    expect(body(event)).not.toHaveProperty("tool_definition_tokens");
    expect(body(event)).not.toHaveProperty("system_context_digest");
    expect(body(event)).not.toHaveProperty("system_context_parts");
  });
});

describe("when the recorder lists a call's system context", () => {
  it("lists the parts on the first call of a turn and the digest alone after", () => {
    const chain = recorder();
    const first = call(chain);
    const second = call(chain);
    expect(parts(first)).toHaveLength(3);
    expect(parts(second)).toBeUndefined();
    expect(body(second)["system_context_digest"]).toBe(
      body(first)["system_context_digest"],
    );
    chain.ingestHook(
      { session_id: ID, hook_event_name: "UserPromptSubmit", prompt: "go" },
      {},
      at,
    );
    expect(parts(call(chain))).toHaveLength(3);
  });

  it("lists again after a rollback undid the call that listed", () => {
    const chain = recorder();
    const mark = chain.markChain();
    expect(parts(call(chain))).toHaveLength(3);
    chain.rollbackChain(mark);
    expect(parts(call(chain))).toHaveLength(3);
  });

  it("carries the steering and the turn's listing over a restart", () => {
    const before = recorder();
    before.sealCollectorEvent("steering.manifest", MANIFEST, {
      hook_event_name: "SessionStart",
    });
    call(before);
    const state = before.state();
    expect(state.systemContext?.steering).toHaveLength(1);
    const after = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: state,
    });
    const event = call(after);
    expect(parts(event)).toBeUndefined();
    expect(body(event)["steering_tokens"]).toBe(40);
  });

  it("writes no system context state before a call or a manifest", () => {
    expect(recorder().state()).not.toHaveProperty("systemContext");
  });
});

const TS_NANOS = "1790380800000000000";
const MODEL = "claude-opus-4-5";

/** The members only a recorder that saw the request can set. */
const REQUEST_MEMBERS = [
  "tool_definition_tokens",
  "tool_definition_tokens_basis",
  "context_frame_tokens",
  "context_frame_tokens_basis",
  "system_context_digest",
  "system_context_parts",
] as const;

function kv(key: string, value: string | number) {
  return typeof value === "number"
    ? { key, value: { intValue: String(value) } }
    : { key, value: { stringValue: value } };
}

/**
 * Claude Code's OTel `api_request` record for one model call. By default the
 * call is on the main thread of an interactive session. `over` changes an
 * attribute, and an undefined value leaves it out.
 */
function apiRequest(
  request: string,
  over: Record<string, string | number | undefined> = {},
) {
  const attrs: Record<string, string | number | undefined> = {
    model: MODEL,
    request_id: request,
    input_tokens: 10,
    output_tokens: 5,
    query_source: "repl_main_thread",
    ...over,
  };
  return {
    resourceLogs: [
      {
        resource: { attributes: [kv("os.type", "linux")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: TS_NANOS,
                body: { stringValue: "claude_code.api_request" },
                attributes: Object.entries(attrs).flatMap(([k, v]) =>
                  v === undefined ? [] : [kv(k, v)],
                ),
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * A side call's `query_source`. Any value other than the main thread's reads
 * the same, so this one only stands for the subsystem that made the call.
 */
const SIDE_SOURCE = "session_title";

/** The transcript's `assistant` record for one content block of a call. */
function assistantRecord(request: string, block: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${request}-${block}`,
    requestId: request,
    timestamp: at,
    message: {
      model: MODEL,
      id: `msg-${request}`,
      content: [{ type: "text", text: `block ${block}` }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function withManifest(): SessionRecorder {
  const chain = recorder();
  chain.sealCollectorEvent("steering.manifest", MANIFEST, {
    hook_event_name: "SessionStart",
  });
  return chain;
}

function modelCalls(events: readonly TachoEvent[]): TachoEvent[] {
  return events.filter((event) => event.kind === "llm_call");
}

function expectSteeringOnly(event: TachoEvent): void {
  expect(body(event)["steering_tokens"]).toBe(40);
  expect(body(event)["steering_tokens_basis"]).toBe("estimated");
  for (const member of REQUEST_MEMBERS)
    expect(body(event)).not.toHaveProperty(member);
}

function expectNoSources(event: TachoEvent): void {
  expect(body(event)).not.toHaveProperty("steering_tokens");
  expect(body(event)).not.toHaveProperty("steering_tokens_basis");
  for (const member of REQUEST_MEMBERS)
    expect(body(event)).not.toHaveProperty(member);
}

describe("a model call the proxy did not carry", () => {
  it("carries the steering count alone on its counted transcript row", () => {
    const [row] = modelCalls(
      withManifest().ingestTranscriptLine(assistantRecord("req_t", 0)),
    );
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(countsLlmCallUsage(row)).toBe(true);
    expectSteeringOnly(row);
  });

  it("carries the steering count alone on its counted OTel row", () => {
    const [row] = modelCalls(withManifest().ingestOtlp(apiRequest("req_o")));
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.source).toBe("otel_log");
    expect(countsLlmCallUsage(row)).toBe(true);
    expectSteeringOnly(row);
  });

  it("counts steering on a main call and none on a side call", () => {
    const chain = withManifest();
    const [main] = modelCalls(chain.ingestOtlp(apiRequest("req_main")));
    const [side] = modelCalls(
      chain.ingestOtlp(
        apiRequest("req_side", {
          model: "claude-haiku-4-5",
          query_source: SIDE_SOURCE,
        }),
      ),
    );
    expect(main).toBeDefined();
    expect(side).toBeDefined();
    if (main === undefined || side === undefined) return;
    // Both rows are counted. Only the main call carries the conversation
    // that the steering rode in on.
    expect(countsLlmCallUsage(main)).toBe(true);
    expect(countsLlmCallUsage(side)).toBe(true);
    expectSteeringOnly(main);
    expectNoSources(side);
  });

  it("counts steering on a print-mode call and a qualified main-thread call", () => {
    const chain = withManifest();
    const sources = ["sdk", "repl_main_thread:outputStyle:Explanatory"];
    for (const [index, source] of sources.entries()) {
      const [row] = modelCalls(
        chain.ingestOtlp(apiRequest(`req_m${index}`, { query_source: source })),
      );
      expect(row).toBeDefined();
      if (row !== undefined) expectSteeringOnly(row);
    }
  });

  it("adds nothing to a compaction or a row that names no source", () => {
    const chain = withManifest();
    const rows = modelCalls([
      ...chain.ingestOtlp(apiRequest("req_c", { query_source: "compact" })),
      ...chain.ingestOtlp(apiRequest("req_n", { query_source: undefined })),
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(countsLlmCallUsage(row)).toBe(true);
      expectNoSources(row);
    }
  });

  it("adds nothing to either sighting of a side call", () => {
    const chain = withManifest();
    const [otel] = modelCalls(
      chain.ingestOtlp(
        apiRequest("req_sp", {
          model: "claude-haiku-4-5",
          query_source: SIDE_SOURCE,
        }),
      ),
    );
    // The rollup joins a stamped proxy row back for a member the counted row
    // lacks, so the proxy row must not carry the steering either.
    const proxied = call(
      chain,
      { model: "claude-haiku-4-5", request_id: "req_sp" },
      SIDE_REQUEST,
    );
    expect(proxied.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("otel_log");
    expect(otel).toBeDefined();
    if (otel === undefined) return;
    expectNoSources(otel);
    expect(body(proxied)).not.toHaveProperty("steering_tokens");
  });

  it("adds nothing to a later sighting of the same call", () => {
    const chain = withManifest();
    chain.ingestTranscriptLine(assistantRecord("req_t", 0));
    // A second content block of the same message, then OTel's record of it.
    const block = modelCalls(
      chain.ingestTranscriptLine(assistantRecord("req_t", 1)),
    );
    const otel = modelCalls(chain.ingestOtlp(apiRequest("req_t")));
    expect(block).toHaveLength(1);
    expect(otel).toHaveLength(1);
    for (const row of [...block, ...otel]) {
      expect(row.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("transcript");
      expectNoSources(row);
    }
  });

  it("adds nothing before a steering manifest seals", () => {
    const chain = recorder();
    const rows = modelCalls([
      ...chain.ingestTranscriptLine(assistantRecord("req_t", 0)),
      ...chain.ingestOtlp(apiRequest("req_o")),
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expectNoSources(row);
  });

  it("adds nothing to a subagent's row, whose chain was delivered no manifest", () => {
    const chain = withManifest();
    const rows = modelCalls(
      chain.ingestTranscriptLine(assistantRecord("req_s", 0), "agent-a"),
    );
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.subagent?.subagent_id).toBe("agent-a");
      expectNoSources(row);
    }
  });

  it("gives the OTel row and the proxy row of one call the same steering count", () => {
    const chain = withManifest();
    const [otel] = modelCalls(chain.ingestOtlp(apiRequest("req_p")));
    // The proxy seals as the response ends, so OTel can be first. The proxy
    // row is then the stamped one, and a reader joins it back for the
    // tool definitions and the system context.
    const proxied = call(chain, { request_id: "req_p" });
    expect(proxied.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("otel_log");
    expect(otel).toBeDefined();
    if (otel === undefined) return;
    expect(body(otel)["steering_tokens"]).toBe(
      body(proxied)["steering_tokens"],
    );
    expect(body(proxied)["tool_definition_tokens"]).toBeGreaterThan(0);
    expect(body(proxied)["system_context_digest"]).toMatch(/^sha256:/);
  });
});

/** Text an Oxagen hook answer handed the agent: a prompt's recall. */
const RECALLED =
  "Memories Oxagen recalled for this prompt, most relevant first:\n" +
  "- Use pnpm, never npm.";
/** Before the calls below, which the OTel and transcript records date at `at`. */
const HANDED_AT = "2026-09-25T23:59:00.000Z";
/** After them. */
const LATE_AT = "2026-09-26T00:01:00.000Z";
/** Between the handed text and the calls. */
const RESTART_AT = "2026-09-25T23:59:30.000Z";

/** The count the recall adds: its UTF-8 bytes over four, rounded up. */
const RECALLED_TOKENS = Math.ceil(Buffer.byteLength(RECALLED, "utf8") / 4);

function contextTokens(event: TachoEvent | undefined): unknown {
  return event === undefined ? undefined : body(event)["context_frame_tokens"];
}

describe("the context Oxagen's hooks handed a session the proxy did not carry (#5339)", () => {
  it("counts the handed text on the counted OTel and transcript rows", () => {
    const chain = recorder();
    chain.noteInjectedContext(RECALLED, HANDED_AT);
    const rows = modelCalls([
      ...chain.ingestOtlp(apiRequest("req_o")),
      ...chain.ingestTranscriptLine(assistantRecord("req_t", 0)),
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(countsLlmCallUsage(row)).toBe(true);
      expect(body(row)["context_frame_tokens"]).toBe(RECALLED_TOKENS);
      expect(body(row)["context_frame_tokens_basis"]).toBe("estimated");
      // The request is still out of sight.
      expect(body(row)).not.toHaveProperty("tool_definition_tokens");
      expect(body(row)).not.toHaveProperty("system_context_digest");
    }
  });

  it("leaves the count absent, never zero, when no hook handed the agent text", () => {
    const [row] = modelCalls(withManifest().ingestOtlp(apiRequest("req_o")));
    expect(row).toBeDefined();
    if (row === undefined) return;
    expectSteeringOnly(row);
    expect(body(row)).not.toHaveProperty("context_frame_tokens");
  });

  it("counts nothing on a call made before the text was handed", () => {
    const chain = recorder();
    chain.noteInjectedContext(RECALLED, LATE_AT);
    const [row] = modelCalls(chain.ingestOtlp(apiRequest("req_o")));
    expect(row).toBeDefined();
    if (row === undefined) return;
    expectNoSources(row);
  });

  it("counts nothing on a side call, a later sighting, or a subagent's row", () => {
    const chain = recorder();
    chain.noteInjectedContext(RECALLED, HANDED_AT);
    chain.ingestTranscriptLine(assistantRecord("req_t", 0));
    const rows = modelCalls([
      ...chain.ingestOtlp(
        apiRequest("req_side", { query_source: SIDE_SOURCE }),
      ),
      ...chain.ingestOtlp(apiRequest("req_t")),
      ...chain.ingestTranscriptLine(assistantRecord("req_s", 0), "agent-a"),
    ]);
    expect(rows).toHaveLength(3);
    for (const row of rows) expectNoSources(row);
  });

  it("empties the count at a compaction's start and keeps it over a resume's", () => {
    const compacted = recorder();
    compacted.noteInjectedContext(RECALLED, HANDED_AT);
    compacted.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart", source: "compact" },
      {},
      RESTART_AT,
    );
    const [after] = modelCalls(compacted.ingestOtlp(apiRequest("req_c")));
    expect(after).toBeDefined();
    expect(contextTokens(after)).toBeUndefined();

    const resumed = recorder();
    resumed.noteInjectedContext(RECALLED, HANDED_AT);
    resumed.ingestHook(
      { session_id: ID, hook_event_name: "SessionStart", source: "resume" },
      {},
      RESTART_AT,
    );
    const [kept] = modelCalls(resumed.ingestOtlp(apiRequest("req_r")));
    expect(contextTokens(kept)).toBe(RECALLED_TOKENS);
  });

  it("gives the OTel row and the proxy row of one call the same count", () => {
    const chain = recorder();
    chain.noteInjectedContext(RECALLED, HANDED_AT);
    const [otel] = modelCalls(chain.ingestOtlp(apiRequest("req_p")));
    const proxied = call(chain, { request_id: "req_p" });
    expect(proxied.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("otel_log");
    expect(contextTokens(otel)).toBe(RECALLED_TOKENS);
    expect(contextTokens(proxied)).toBe(RECALLED_TOKENS);
  });

  it("takes the note back with a rollback and carries it over a restart", () => {
    const rolled = recorder();
    const mark = rolled.markChain();
    rolled.noteInjectedContext(RECALLED, HANDED_AT);
    rolled.rollbackChain(mark);
    const [none] = modelCalls(rolled.ingestOtlp(apiRequest("req_b")));
    expect(none).toBeDefined();
    expect(contextTokens(none)).toBeUndefined();

    const before = recorder();
    before.noteInjectedContext(RECALLED, HANDED_AT);
    const after = new SessionRecorder({
      context,
      harnessSessionId: ID,
      scope: SCOPE,
      restore: before.state(),
    });
    const [row] = modelCalls(after.ingestOtlp(apiRequest("req_o")));
    expect(contextTokens(row)).toBe(RECALLED_TOKENS);
  });
});
