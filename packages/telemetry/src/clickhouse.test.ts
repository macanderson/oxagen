// clickhouse.test.ts
//
// Unit tests for the pure, I/O-free utility functions exported from clickhouse.ts.
// These functions are called by packages/ai (stream.ts, embed.ts) and must be
// stable across model id formats — hence dedicated coverage here rather than
// relying on consumer mocks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPrompt, providerFromModelId } from "./clickhouse";

// ---------------------------------------------------------------------------
// hashPrompt
// ---------------------------------------------------------------------------

describe("hashPrompt", () => {
  it("returns a 32-character hex string", async () => {
    const result = await hashPrompt("hello world");
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for the same input", async () => {
    const a = await hashPrompt("consistent input");
    const b = await hashPrompt("consistent input");
    expect(a).toBe(b);
  });

  it("returns different hashes for different inputs", async () => {
    const a = await hashPrompt("input-a");
    const b = await hashPrompt("input-b");
    expect(a).not.toBe(b);
  });

  it("handles an empty string without throwing", async () => {
    const result = await hashPrompt("");
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// providerFromModelId
// ---------------------------------------------------------------------------

describe("providerFromModelId", () => {
  it("maps a bare claude model id to 'anthropic'", () => {
    expect(providerFromModelId("claude-sonnet-4-6")).toBe("anthropic");
    expect(providerFromModelId("claude-3-haiku-20240307")).toBe("anthropic");
    expect(providerFromModelId("claude-opus-4")).toBe("anthropic");
  });

  it("maps a bare gpt model id to 'openai'", () => {
    expect(providerFromModelId("gpt-4o")).toBe("openai");
    expect(providerFromModelId("gpt-3.5-turbo")).toBe("openai");
  });

  it("maps o-series model ids to 'openai'", () => {
    expect(providerFromModelId("o1-preview")).toBe("openai");
    expect(providerFromModelId("o3-mini")).toBe("openai");
    expect(providerFromModelId("o4-mini")).toBe("openai");
  });

  it("maps text-embedding model ids to 'openai'", () => {
    expect(providerFromModelId("text-embedding-3-small")).toBe("openai");
    expect(providerFromModelId("text-embedding-ada-002")).toBe("openai");
  });

  it("maps the prefixed form 'anthropic:claude-3' to 'anthropic'", () => {
    expect(providerFromModelId("anthropic:claude-3-haiku-20240307")).toBe("anthropic");
    expect(providerFromModelId("anthropic:claude-sonnet-4-6")).toBe("anthropic");
  });

  it("maps the prefixed form 'openai:gpt-4o' to 'openai'", () => {
    expect(providerFromModelId("openai:gpt-4o")).toBe("openai");
  });

  it("returns '' for an unknown model id", () => {
    expect(providerFromModelId("unknown-model-xyz")).toBe("");
    expect(providerFromModelId("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// clickhouse() client construction
//
// Regression guard: every caller stamps timestamps with `Date.toISOString()`
// (ISO-8601 `T`/`Z` form). ClickHouse's default `basic` date_time_input_format
// rejects that against DateTime64 columns ("Cannot parse input ... created_at"),
// silently dropping all token/tool telemetry. The singleton must enable
// `best_effort` parsing so ISO timestamps ingest. This test fails if that
// setting is ever dropped from createClient.
// ---------------------------------------------------------------------------

const createClientMock = vi.hoisted(() =>
  vi.fn((_config: { clickhouse_settings?: { date_time_input_format?: string } }) => ({
    close: vi.fn(),
  })),
);

vi.mock("@clickhouse/client", () => ({
  createClient: createClientMock,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    CLICKHOUSE_URL: "https://ch.example",
    CLICKHOUSE_USERNAME: "u",
    CLICKHOUSE_PASSWORD: "p",
    CLICKHOUSE_DATABASE: "db",
  }),
}));

// ---------------------------------------------------------------------------
// providerFromModelId — extended cases
// (covers image/video/gateway/slash/uppercase-prefix forms)
// ---------------------------------------------------------------------------

describe("providerFromModelId — image model ids", () => {
  it("gpt-image-1 → 'openai'", () => {
    expect(providerFromModelId("gpt-image-1")).toBe("openai");
  });

  it("dall-e-3 → 'openai'", () => {
    expect(providerFromModelId("dall-e-3")).toBe("openai");
  });

  it("chatgpt-4o-latest → 'openai'", () => {
    expect(providerFromModelId("chatgpt-4o-latest")).toBe("openai");
  });

  it("davinci-003 → 'openai'", () => {
    expect(providerFromModelId("davinci-003")).toBe("openai");
  });
});

describe("providerFromModelId — Google model ids", () => {
  it("gemini-1.5-pro → 'google'", () => {
    expect(providerFromModelId("gemini-1.5-pro")).toBe("google");
  });

  it("veo-3.0-fast-generate-001 → 'google' (bare form)", () => {
    expect(providerFromModelId("veo-3.0-fast-generate-001")).toBe("google");
  });

  it("imagen-3 → 'google'", () => {
    expect(providerFromModelId("imagen-3")).toBe("google");
  });
});

describe("providerFromModelId — Black Forest Labs (bfl) model ids", () => {
  it("flux-1-dev → 'bfl' (bare flux prefix)", () => {
    expect(providerFromModelId("flux-1-dev")).toBe("bfl");
  });

  it("bfl/flux-2-max → 'bfl' (slash gateway form: 'bfl' head)", () => {
    expect(providerFromModelId("bfl/flux-2-max")).toBe("bfl");
  });
});

describe("providerFromModelId — xAI model ids", () => {
  it("grok-2 → 'xai'", () => {
    expect(providerFromModelId("grok-2")).toBe("xai");
  });
});

describe("providerFromModelId — slash gateway / colon-prefix forms", () => {
  it("google/veo-3.0-generate-001 → 'google' (slash gateway form)", () => {
    expect(providerFromModelId("google/veo-3.0-generate-001")).toBe("google");
  });

  it("bfl/flux-2-max → 'bfl' (slash gateway form)", () => {
    expect(providerFromModelId("bfl/flux-2-max")).toBe("bfl");
  });

  it("leading-slash '/claude-3' → '' (no known head)", () => {
    // The split is on /[:/]/, so the first chunk is empty string ("").
    // Empty string doesn't match any known prefix in the switch.
    // "claude" prefix check: id.startsWith("claude") = false (starts with "/").
    expect(providerFromModelId("/claude-3")).toBe("");
  });
});

describe("providerFromModelId — uppercase prefix forms", () => {
  it("ANTHROPIC/claude-3 → 'anthropic' (uppercase prefix matched case-insensitively)", () => {
    // head = "ANTHROPIC".toLowerCase() = "anthropic" → matched in switch
    expect(providerFromModelId("ANTHROPIC/claude-3")).toBe("anthropic");
  });
});

describe("clickhouse client construction", () => {
  afterEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
  });

  it("enables best_effort date_time_input_format so ISO-8601 timestamps ingest", async () => {
    // Re-import under the mocks with a fresh module registry so the singleton
    // is rebuilt and createClient is actually invoked.
    vi.resetModules();
    const { clickhouse, closeClickhouse } = await import("./clickhouse");
    await closeClickhouse();
    clickhouse();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const config = createClientMock.mock.calls[0]![0];
    expect(config.clickhouse_settings?.date_time_input_format).toBe("best_effort");
  });
});

// ---------------------------------------------------------------------------
// insert helpers — insertRows delegation
// All insert* helpers are thin wrappers around the private insertRows()
// which calls clickhouse().insert({ table, values, format: "JSONEachRow" }).
// We test each wrapper verifies the table name and passes the rows through.
// ---------------------------------------------------------------------------

describe("insert helpers — insertRows delegation", () => {
  let insertMock: ReturnType<typeof vi.fn>;
  let mod: typeof import("./clickhouse");

  beforeEach(async () => {
    insertMock = vi.fn().mockResolvedValue(undefined);
    createClientMock.mockImplementation(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      insert: insertMock,
      query: vi.fn(),
    }));
    vi.resetModules();
    mod = await import("./clickhouse");
    mod.clickhouse(); // prime singleton
  });

  afterEach(async () => {
    await mod.closeClickhouse();
    vi.resetModules();
  });

  it("no-ops when rows array is empty (insertExecutionLogs)", async () => {
    await mod.insertExecutionLogs([]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("insertExecutionLogs delegates to execution_logs table", async () => {
    const row: mod.ExecutionLogRow = {
      execution_id: "exec-1",
      step_id: null,
      org_id: "org-1",
      workspace_id: "ws-1",
      log_level: "info",
      message: "hello",
      metadata: "{}",
      created_at: new Date().toISOString(),
    };
    await mod.insertExecutionLogs([row]);
    expect(insertMock).toHaveBeenCalledWith({
      table: "execution_logs",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertTraces delegates to traces table", async () => {
    const row: mod.TraceRow = {
      trace_id: "t1",
      execution_id: "e1",
      org_id: "o1",
      started_at: new Date().toISOString(),
      completed_at: null,
    };
    await mod.insertTraces([row]);
    expect(insertMock).toHaveBeenCalledWith({
      table: "traces",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertSpans delegates to spans table", async () => {
    const row: mod.SpanRow = {
      span_id: "s1",
      trace_id: "t1",
      parent_span_id: null,
      span_type: "llm",
      org_id: "o1",
      started_at: new Date().toISOString(),
      completed_at: null,
      metadata: "{}",
    };
    await mod.insertSpans([row]);
    expect(insertMock).toHaveBeenCalledWith({
      table: "spans",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertEvents delegates to events table", async () => {
    const row: mod.EventRow = {
      event_id: "ev1",
      org_id: "o1",
      workspace_id: "w1",
      event_type: "test",
      source_system: "api",
      stream_offset: null,
      payload: "{}",
      emitted_at: new Date().toISOString(),
    };
    await mod.insertEvents([row]);
    expect(insertMock).toHaveBeenCalledWith({
      table: "events",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertApiKeyEvents delegates to api_key_events table", async () => {
    const row: mod.ApiKeyEventRow = {
      api_key_id: "ak1",
      org_id: "o1",
      ip_address: "1.2.3.4",
      user_agent: "test-agent",
      request_path: "/api/v1/test",
      response_code: 200,
      created_at: new Date().toISOString(),
    };
    await mod.insertApiKeyEvents([row]);
    expect(insertMock).toHaveBeenCalledWith({
      table: "api_key_events",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertTokenUsage delegates to token_usage table", async () => {
    const row: mod.TokenUsageRow = {
      execution_step_id: "es1",
      org_id: "o1",
      workspace_id: "w1",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 0,
      cost_usd_micros: 1500,
      duration_ms: 1200,
      surface: "api",
      prompt_hash: "abc123def456abc1",
      created_at: new Date().toISOString(),
    };
    await mod.insertTokenUsage([row]);
    expect(insertMock).toHaveBeenCalledWith({
      table: "token_usage",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertToolInvocation delegates to tool_invocations table with single-element array", async () => {
    const row: mod.ToolInvocationRow = {
      invocation_id: "inv1",
      org_id: "o1",
      workspace_id: "w1",
      capability_name: "chat.message.send",
      message_id: "m1",
      parent_message_id: null,
      execution_step_id: null,
      status: "completed",
      input_size_bytes: 100,
      output_size_bytes: 200,
      latency_ms: 500,
      error_class: null,
      external_provider: "",
      external_server_id: null,
      risk_level: "low",
      required_approval: 0,
      surface: "api",
      provider: "anthropic",
      created_at: new Date().toISOString(),
    };
    await mod.insertToolInvocation(row);
    expect(insertMock).toHaveBeenCalledWith({
      table: "tool_invocations",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("insertAuditEvent delegates to audit_events table", async () => {
    const row: mod.AuditEventRow = {
      occurred_at: new Date().toISOString(),
      event_id: "ae1",
      org_id: "o1",
      workspace_id: "w1",
      capability: "chat.message.send",
      scope_kind: "org",
      scope_id: "o1",
      acting_principal_id: "u1",
      acting_principal_kind: "human",
      human_principal_id: "u1",
      outcome: "allow",
      decision_reason: "IAM allow",
      target_kind: null,
      target_id: null,
      payload_hash: "abc",
      chain_hash: "def",
      ip: "1.2.3.4",
      ua: "Mozilla",
      request_id: "req1",
      correlation_id: null,
      trace_jsonb: "{}",
    };
    await mod.insertAuditEvent(row);
    expect(insertMock).toHaveBeenCalledWith({
      table: "audit_events",
      values: [row],
      format: "JSONEachRow",
    });
  });

  it("no-ops when rows array is empty (any insert helper)", async () => {
    await mod.insertTraces([]);
    await mod.insertSpans([]);
    await mod.insertEvents([]);
    await mod.insertTokenUsage([]);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sumTokenUsage
// ---------------------------------------------------------------------------

describe("sumTokenUsage", () => {
  let queryMock: ReturnType<typeof vi.fn>;
  let mod: typeof import("./clickhouse");

  beforeEach(async () => {
    queryMock = vi.fn();
    createClientMock.mockImplementation(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
      query: queryMock,
    }));
    vi.resetModules();
    mod = await import("./clickhouse");
    mod.clickhouse();
  });

  afterEach(async () => {
    await mod.closeClickhouse();
    vi.resetModules();
  });

  it("returns rollup rows when ClickHouse returns one row", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        {
          input_tokens: "1000",
          output_tokens: "500",
          cached_tokens: "200",
          cost_micros: "150000",
          row_count: "10",
        },
      ]),
    });

    const result = await mod.sumTokenUsage({
      orgId: "org-uuid-1",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
    });

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ metric: "tokens_input", quantity: 1000, costMicros: 0n });
    expect(result[1]).toEqual({ metric: "tokens_output", quantity: 500, costMicros: 0n });
    expect(result[2]).toEqual({ metric: "tokens_cached", quantity: 200, costMicros: 0n });
    expect(result[3]).toEqual({ metric: "executions", quantity: 10, costMicros: 150000n });
  });

  it("returns zero-filled rollup when ClickHouse returns no rows", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });

    const result = await mod.sumTokenUsage({
      orgId: "org-uuid-1",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
    });

    expect(result[0]).toEqual({ metric: "tokens_input", quantity: 0, costMicros: 0n });
    expect(result[1]).toEqual({ metric: "tokens_output", quantity: 0, costMicros: 0n });
    expect(result[2]).toEqual({ metric: "tokens_cached", quantity: 0, costMicros: 0n });
    expect(result[3]).toEqual({ metric: "executions", quantity: 0, costMicros: 0n });
  });

  it("strips the trailing Z from ISO date strings in query params", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        { input_tokens: "0", output_tokens: "0", cached_tokens: "0", cost_micros: "0", row_count: "0" },
      ]),
    });

    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-02-01T00:00:00.000Z");

    await mod.sumTokenUsage({ orgId: "o1", periodStart: start, periodEnd: end });

    const callArgs = queryMock.mock.calls[0]![0];
    // The query replaces trailing Z so ClickHouse DateTime64 can parse
    expect(callArgs.query_params.periodStart).toBe("2026-01-01T00:00:00.000");
    expect(callArgs.query_params.periodEnd).toBe("2026-02-01T00:00:00.000");
    expect(callArgs.query_params.periodStart).not.toMatch(/Z$/);
  });

  it("passes orgId and uses JSONEachRow format", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([
        { input_tokens: "0", output_tokens: "0", cached_tokens: "0", cost_micros: "0", row_count: "0" },
      ]),
    });

    await mod.sumTokenUsage({
      orgId: "my-org-uuid",
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date("2026-02-01"),
    });

    const callArgs = queryMock.mock.calls[0]![0];
    expect(callArgs.query_params.orgId).toBe("my-org-uuid");
    expect(callArgs.format).toBe("JSONEachRow");
    expect(callArgs.query).toContain("token_usage");
  });
});

// ---------------------------------------------------------------------------
// latestAuditChainHash
// ---------------------------------------------------------------------------

describe("latestAuditChainHash", () => {
  let queryMock: ReturnType<typeof vi.fn>;
  let mod: typeof import("./clickhouse");

  beforeEach(async () => {
    queryMock = vi.fn();
    createClientMock.mockImplementation(() => ({
      close: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined),
      query: queryMock,
    }));
    vi.resetModules();
    mod = await import("./clickhouse");
    mod.clickhouse();
  });

  afterEach(async () => {
    await mod.closeClickhouse();
    vi.resetModules();
  });

  it("returns the chain_hash from the most recent audit event", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ chain_hash: "abc123def456" }]),
    });

    const hash = await mod.latestAuditChainHash({ orgId: "o1", capability: "chat.message.send" });
    expect(hash).toBe("abc123def456");
  });

  it("returns empty string when no prior events exist", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });

    const hash = await mod.latestAuditChainHash({ orgId: "o1", capability: "chat.message.send" });
    expect(hash).toBe("");
  });

  it("queries audit_events FINAL ordered by occurred_at DESC with LIMIT 1", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });

    await mod.latestAuditChainHash({ orgId: "org-uuid", capability: "test.capability" });

    const callArgs = queryMock.mock.calls[0]![0];
    expect(callArgs.query).toContain("audit_events FINAL");
    expect(callArgs.query).toContain("ORDER BY occurred_at DESC");
    expect(callArgs.query).toContain("LIMIT 1");
    expect(callArgs.query_params.orgId).toBe("org-uuid");
    expect(callArgs.query_params.capability).toBe("test.capability");
    expect(callArgs.format).toBe("JSONEachRow");
  });
});

// ---------------------------------------------------------------------------
// closeClickhouse — branch when client exists
// ---------------------------------------------------------------------------

describe("closeClickhouse — with an active client", () => {
  let closeMock: ReturnType<typeof vi.fn>;
  let mod: typeof import("./clickhouse");

  beforeEach(async () => {
    closeMock = vi.fn().mockResolvedValue(undefined);
    createClientMock.mockImplementation(() => ({
      close: closeMock,
      insert: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
    }));
    vi.resetModules();
    mod = await import("./clickhouse");
    mod.clickhouse(); // creates the singleton → _client is now set
  });

  afterEach(async () => {
    vi.resetModules();
  });

  it("calls client.close() and nulls out the singleton", async () => {
    await mod.closeClickhouse();
    expect(closeMock).toHaveBeenCalledTimes(1);
    // A second close should be a no-op (singleton is null)
    await mod.closeClickhouse();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// providerFromModelId — meta / mistral / deepseek prefix forms
// ---------------------------------------------------------------------------

describe("providerFromModelId — meta / mistral / deepseek prefix forms", () => {
  it("meta/llama-3 → 'meta' (slash gateway form)", () => {
    expect(providerFromModelId("meta/llama-3")).toBe("meta");
  });

  it("mistral/mistral-7b → 'mistral' (slash gateway form)", () => {
    expect(providerFromModelId("mistral/mistral-7b")).toBe("mistral");
  });

  it("deepseek/deepseek-v2 → 'deepseek' (slash gateway form)", () => {
    expect(providerFromModelId("deepseek/deepseek-v2")).toBe("deepseek");
  });

  it("xai/grok-3 → 'xai' (slash gateway form)", () => {
    expect(providerFromModelId("xai/grok-3")).toBe("xai");
  });
});
