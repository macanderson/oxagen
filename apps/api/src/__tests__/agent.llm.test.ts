/**
 * Unit tests for POST /v1/agent/llm/chat/completions
 *
 * The OpenAI-compatible agent LLM proxy used by the CLI (ADR-019 B4). Covers:
 * auth guard, body validation, OpenAI request → AI SDK message/tool conversion,
 * AI SDK fullStream → OpenAI chat.completion.chunk SSE translation (text + tool
 * calls + usage), the non-streaming chat.completion path, system hoisting, and
 * error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),

  streamAgentReply: vi.fn(),
  selectModel: vi.fn(),
  // tool/jsonSchema are pure helpers — identity-ish so we can assert on inputs.
  tool: vi.fn((def: unknown) => ({ __tool: def })),
  jsonSchema: vi.fn((s: unknown) => ({ __schema: s })),

  invoke: vi.fn(),
  materializeTools: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/ai", () => ({
  streamAgentReply: mocks.streamAgentReply,
  selectModel: mocks.selectModel,
  tool: mocks.tool,
  jsonSchema: mocks.jsonSchema,
}));

vi.mock("@oxagen/agent", () => ({
  materializeTools: mocks.materializeTools,
}));

// Spread the real module so new module-level `schema.<table>` projections in
// transitively imported services never crash this suite at import time; only
// the DB entrypoint is overridden.
vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: vi.fn((...args) => ({ and: args })),
    desc: vi.fn((col: unknown) => ({ desc: col })),
    eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  };
});

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PATH = "/v1/agent/llm/chat/completions";

function post(body: unknown, extraHeaders?: Record<string, string>): Request {
  return makeRequest(PATH, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/** A fake StreamTextResult whose fullStream yields the given parts. */
function streamResult(parts: unknown[]): {
  fullStream: AsyncIterable<unknown>;
} {
  async function* gen() {
    for (const p of parts) yield p;
  }
  return { fullStream: gen() };
}

/** A fake StreamTextResult exposing the resolved promises (non-stream path). */
function genResult(opts: {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason?: string;
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}) {
  return {
    text: Promise.resolve(opts.text ?? ""),
    toolCalls: Promise.resolve(opts.toolCalls ?? []),
    finishReason: Promise.resolve(opts.finishReason ?? "stop"),
    totalUsage: Promise.resolve(
      opts.totalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ),
  };
}

/** Parse all JSON `data:` chunks from an SSE body (skips the [DONE] sentinel). */
async function readChunks(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (raw === "[DONE]") break;
    try {
      out.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // skip
    }
  }
  return out;
}

function deltasOf(
  chunks: Record<string, unknown>[],
): Record<string, unknown>[] {
  return chunks
    .flatMap((c) => (c.choices as Array<{ delta?: unknown }>) ?? [])
    .map((ch) => (ch.delta ?? {}) as Record<string, unknown>);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.selectModel.mockReturnValue("model-obj");
  mocks.tool.mockImplementation((def: unknown) => ({ __tool: def }));
  mocks.jsonSchema.mockImplementation((s: unknown) => ({ __schema: s }));
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  // Default: a single text-delta then finish.
  mocks.streamAgentReply.mockReturnValue(
    streamResult([
      { type: "text-delta", text: "Hello" },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      },
    ]),
  );
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("agent.llm: auth guard", () => {
  it("returns 401 when no auth header", async () => {
    const req = makeRequest(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when API key is invalid", async () => {
    mocks.resolveApiKey.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await app.fetch(
      post({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(401);
  });
});

// ── Body validation ───────────────────────────────────────────────────────────

describe("agent.llm: body validation", () => {
  it("returns 400 for invalid JSON", async () => {
    const req = makeRequest(PATH, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toBeDefined();
  });

  it("returns 400 when model is missing", async () => {
    const res = await app.fetch(
      post({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when messages is empty", async () => {
    const res = await app.fetch(post({ model: "m", messages: [] }));
    expect(res.status).toBe(400);
  });
});

// ── Streaming happy path ────────────────────────────────────────────────────────

describe("agent.llm: streaming happy path", () => {
  it("returns 200 text/event-stream", async () => {
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("emits a leading assistant role chunk then content deltas", async () => {
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    const deltas = deltasOf(await readChunks(res));
    expect(deltas[0]).toEqual({ role: "assistant" });
    const content = deltas
      .map((d) => d.content)
      .filter((c): c is string => typeof c === "string")
      .join("");
    expect(content).toBe("Hello");
  });

  it("emits a terminal finish_reason and a trailing usage chunk", async () => {
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    const chunks = await readChunks(res);
    const finishChunk = chunks.find((c) => {
      const choices = c.choices as Array<{ finish_reason: string | null }>;
      return choices[0]?.finish_reason != null;
    });
    expect(finishChunk).toBeDefined();
    const fr = (finishChunk?.choices as Array<{ finish_reason: string }>)[0]
      ?.finish_reason;
    expect(fr).toBe("stop");

    const usageChunk = chunks.find((c) => c.usage !== undefined);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    });
  });

  it("terminates with the [DONE] sentinel", async () => {
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    );
    const text = await res.text();
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("passes converted messages, model, and agent surface to streamAgentReply", async () => {
    await app.fetch(
      post({
        model: "anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "Hi agent" }],
        stream: true,
      }),
    );
    expect(mocks.selectModel).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-5",
    });
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args.model).toBe("model-obj");
    const messages = args.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toEqual([{ role: "user", content: "Hi agent" }]);
    const telemetry = args.telemetry as { surface: string };
    expect(telemetry.surface).toBe("agent");
  });
});

// ── System hoisting + history conversion ────────────────────────────────────────

describe("agent.llm: message conversion", () => {
  it("hoists system-role messages into the system arg (not messages)", async () => {
    await app.fetch(
      post({
        model: "m",
        stream: true,
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "fix the bug" },
        ],
      }),
    );
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args.system).toBe("You are a coding agent.");
    const messages = args.messages as Array<{ role: string }>;
    expect(messages.every((m) => m.role !== "system")).toBe(true);
    expect(messages).toHaveLength(1);
  });

  it("merges a top-level system field with system-role messages", async () => {
    await app.fetch(
      post({
        model: "m",
        stream: true,
        system: "Top-level rules.",
        messages: [
          { role: "system", content: "Message rules." },
          { role: "user", content: "go" },
        ],
      }),
    );
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args.system).toBe("Top-level rules.\n\nMessage rules.");
  });

  it("converts assistant tool_calls and tool results into AI SDK parts", async () => {
    await app.fetch(
      post({
        model: "m",
        stream: true,
        messages: [
          { role: "user", content: "read the file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "file body" },
          { role: "user", content: "now what" },
        ],
      }),
    );
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const assistant = args.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "read_file",
        input: { path: "a.ts" },
      },
    ]);
    const toolMsg = args.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "read_file",
        output: { type: "text", value: "file body" },
      },
    ]);
  });
});

// ── Tool definitions + tool_choice + max_tokens ────────────────────────────────

describe("agent.llm: tool wiring", () => {
  it("builds a schema-only ToolSet from OpenAI tool definitions", async () => {
    await app.fetch(
      post({
        model: "m",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "read_file" } },
        max_tokens: 2048,
      }),
    );
    expect(mocks.jsonSchema).toHaveBeenCalledWith({
      type: "object",
      properties: { path: { type: "string" } },
    });
    const args = mocks.streamAgentReply.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const tools = args.tools as Record<string, unknown>;
    expect(Object.keys(tools)).toEqual(["read_file"]);
    expect(args.toolChoice).toEqual({ type: "tool", toolName: "read_file" });
    expect(args.maxOutputTokens).toBe(2048);
  });
});

// ── Streaming tool calls ────────────────────────────────────────────────────────

describe("agent.llm: streaming tool calls", () => {
  it("translates tool-input-start/delta into indexed OpenAI tool_calls deltas", async () => {
    mocks.streamAgentReply.mockReturnValue(
      streamResult([
        { type: "tool-input-start", id: "call_1", toolName: "edit" },
        { type: "tool-input-delta", id: "call_1", delta: '{"p":' },
        { type: "tool-input-delta", id: "call_1", delta: '"x"}' },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "edit",
          input: { p: "x" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "edit" }],
        stream: true,
      }),
    );
    const chunks = await readChunks(res);
    const deltas = deltasOf(chunks);
    const toolDeltas = deltas
      .map((d) => d.tool_calls as Array<Record<string, unknown>> | undefined)
      .filter((t): t is Array<Record<string, unknown>> => Array.isArray(t))
      .flat();

    // First tool delta opens the call with index/id/name.
    expect(toolDeltas[0]).toMatchObject({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "edit" },
    });
    // Argument fragments are streamed and reassemble to the full JSON.
    const argString = toolDeltas
      .map(
        (t) =>
          (t.function as { arguments?: string } | undefined)?.arguments ?? "",
      )
      .join("");
    expect(argString).toBe('{"p":"x"}');

    // finish_reason maps tool-calls → tool_calls.
    const finishChunk = chunks.find((c) => {
      const choices = c.choices as Array<{ finish_reason: string | null }>;
      return choices[0]?.finish_reason != null;
    });
    expect(
      (finishChunk?.choices as Array<{ finish_reason: string }>)[0]
        ?.finish_reason,
    ).toBe("tool_calls");
  });

  it("emits full arguments when a tool-call arrives without streamed input", async () => {
    mocks.streamAgentReply.mockReturnValue(
      streamResult([
        {
          type: "tool-call",
          toolCallId: "call_9",
          toolName: "bash",
          input: { cmd: "ls" },
        },
        {
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "run" }],
        stream: true,
      }),
    );
    const toolDeltas = deltasOf(await readChunks(res))
      .map((d) => d.tool_calls as Array<Record<string, unknown>> | undefined)
      .filter((t): t is Array<Record<string, unknown>> => Array.isArray(t))
      .flat();
    const args = toolDeltas
      .map(
        (t) =>
          (t.function as { arguments?: string } | undefined)?.arguments ?? "",
      )
      .join("");
    expect(args).toBe('{"cmd":"ls"}');
  });
});

// ── Non-streaming path ──────────────────────────────────────────────────────────

describe("agent.llm: non-streaming", () => {
  it("returns a chat.completion object with content + usage", async () => {
    mocks.streamAgentReply.mockReturnValue(
      genResult({
        text: "the answer",
        finishReason: "stop",
        totalUsage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      }),
    );
    const res = await app.fetch(
      post({ model: "m", messages: [{ role: "user", content: "q" }] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      object: string;
      choices: Array<{
        message: { role: string; content: string | null };
        finish_reason: string;
      }>;
      usage: Record<string, number>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("the answer");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });

  it("returns tool_calls in the message when the model emits them", async () => {
    mocks.streamAgentReply.mockReturnValue(
      genResult({
        text: "",
        toolCalls: [
          { toolCallId: "c1", toolName: "edit", input: { path: "a.ts" } },
        ],
        finishReason: "tool-calls",
      }),
    );
    const res = await app.fetch(
      post({ model: "m", messages: [{ role: "user", content: "edit" }] }),
    );
    const body = (await res.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };
    expect(body.choices[0]?.message.content).toBeNull();
    expect(body.choices[0]?.message.tool_calls).toEqual([
      {
        id: "c1",
        type: "function",
        function: { name: "edit", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  });

  it("returns a 502 OpenAI error envelope when generation throws", async () => {
    mocks.streamAgentReply.mockImplementation(() => {
      throw new Error("gateway down");
    });
    const res = await app.fetch(
      post({ model: "m", messages: [{ role: "user", content: "q" }] }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.message).toContain("gateway down");
    expect(body.error.type).toBe("upstream_error");
  });
});

// ── Error handling (streaming) ──────────────────────────────────────────────────

describe("agent.llm: streaming error handling", () => {
  it("emits an OpenAI error object for a mid-stream error part, still ends [DONE]", async () => {
    mocks.streamAgentReply.mockReturnValue(
      streamResult([
        { type: "text-delta", text: "partial" },
        { type: "error", error: new Error("rate limited") },
        {
          type: "finish",
          finishReason: "error",
          totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]),
    );
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "q" }],
        stream: true,
      }),
    );
    const text = await res.text();
    expect(text).toContain('"error"');
    expect(text).toContain("rate limited");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("emits an error object and [DONE] when the stream throws", async () => {
    async function* boom(): AsyncGenerator<never> {
      throw new Error("stream exploded");
    }
    mocks.streamAgentReply.mockReturnValue({ fullStream: boom() });
    const res = await app.fetch(
      post({
        model: "m",
        messages: [{ role: "user", content: "q" }],
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("stream exploded");
    expect(text).toContain("[DONE]");
  });
});
