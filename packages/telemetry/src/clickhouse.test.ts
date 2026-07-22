// clickhouse.test.ts
//
// Unit tests for the pure, I/O-free utility functions exported from clickhouse.ts.
// These functions are called by packages/ai (stream.ts, embed.ts) and must be
// stable across model id formats — hence dedicated coverage here rather than
// relying on consumer mocks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPrompt, providerFromModelId } from "./clickhouse";
import type {
  AuditEventRow,
  EvalResultRow,
  EvalRunRow,
  EventRow,
  ExecutionLogRow,
  TokenUsageRow,
  ToolInvocationRow,
} from "./clickhouse";

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
    expect(providerFromModelId("claude-sonnet-5")).toBe("anthropic");
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
    expect(providerFromModelId("anthropic:claude-3-haiku-20240307")).toBe(
      "anthropic",
    );
    expect(providerFromModelId("anthropic:claude-sonnet-5")).toBe("anthropic");
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
  vi.fn(
    (_config: {
      clickhouse_settings?: { date_time_input_format?: string };
    }) => ({
      close: vi.fn(),
    }),
  ),
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
    expect(config.clickhouse_settings?.date_time_input_format).toBe(
      "best_effort",
    );
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
    const row: ExecutionLogRow = {
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

  it("insertEvents delegates to events table", async () => {
    const row: EventRow = {
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
    // insertEvents auto-stamps trace_id/span_id from the active OTEL context;
    // with no tracer initialised currentTraceIds() returns empty strings.
    expect(insertMock).toHaveBeenCalledWith({
      table: "events",
      values: [{ ...row, trace_id: "", span_id: "" }],
      format: "JSONEachRow",
    });
  });

  it("insertTokenUsage delegates to token_usage table", async () => {
    const row: TokenUsageRow = {
      execution_step_id: "11111111-1111-1111-1111-111111111111",
      org_id: "o1",
      workspace_id: "w1",
      model: "claude-sonnet-5",
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
    // A real UUID is passed straight through unchanged (no coalescing).
    // insertTokenUsage also auto-stamps trace_id/span_id from the active OTEL
    // context (empty strings with no tracer) and principal attribution from
    // the ambient tenant scope (sentinels outside any scope — migration 0023).
    expect(insertMock).toHaveBeenCalledWith({
      table: "token_usage",
      values: [
        {
          ...row,
          // insertTokenUsage coalesces the optional fourth token class to 0
          // (matches the ClickHouse column DEFAULT, migration 0026).
          cache_write_tokens: 0,
          trace_id: "",
          span_id: "",
          principal_id: mod.NIL_UUID,
          principal_kind: "",
          user_id: mod.NIL_UUID,
          capability_name: "",
        },
      ],
      format: "JSONEachRow",
    });
  });

  // Regression: the production CANNOT_PARSE_INPUT_ASSERTION_FAILED (code 27)
  // flood was caused by non-UUID correlation strings reaching the UUID column.
  // Callers now express "no execution step" as null; insertTokenUsage must
  // coalesce null → the nil UUID so the non-nullable UUID key column always
  // receives a parseable value. These tests fail on the pre-fix code (which
  // passed the row through verbatim, sending JSON `null` into a UUID column).
  it("coalesces a null execution_step_id to the nil UUID before inserting", async () => {
    const row: TokenUsageRow = {
      execution_step_id: null,
      org_id: "o1",
      workspace_id: "w1",
      model: "text-embedding-3-small",
      provider: "openai",
      input_tokens: 7,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd_micros: 42,
      duration_ms: 12,
      surface: "ingestion",
      prompt_hash: "deadbeefdeadbeef",
      created_at: new Date().toISOString(),
    };
    await mod.insertTokenUsage([row]);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const call = insertMock.mock.calls[0]![0] as {
      table: string;
      values: TokenUsageRow[];
      format: string;
    };
    expect(call.table).toBe("token_usage");
    expect(call.values[0]!.execution_step_id).toBe(mod.NIL_UUID);
    // NIL_UUID must be a valid UUID shape (ClickHouse UUID text parser accepts it).
    expect(mod.NIL_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The other fields are preserved verbatim.
    expect(call.values[0]!.org_id).toBe("o1");
    expect(call.values[0]!.input_tokens).toBe(7);
  });

  // #1076: a text caller that actually wrote cache must forward the real
  // cache_write_tokens count (the fourth token class) — not lose it to the
  // coalescing default — so the billing rollup prices it at the write premium.
  it("forwards a real cache_write_tokens count through to the row", async () => {
    const row: TokenUsageRow = {
      execution_step_id: "33333333-3333-3333-3333-333333333333",
      org_id: "o1",
      workspace_id: "w1",
      model: "claude-sonnet-5",
      provider: "anthropic",
      input_tokens: 10_000,
      output_tokens: 500,
      cached_tokens: 2_000,
      cache_write_tokens: 3_000,
      cost_usd_micros: 9999,
      duration_ms: 800,
      surface: "api",
      prompt_hash: "cafecafecafecafe",
      created_at: new Date().toISOString(),
    };
    await mod.insertTokenUsage([row]);
    const call = insertMock.mock.calls[0]![0] as { values: TokenUsageRow[] };
    expect(call.values[0]!.cache_write_tokens).toBe(3_000);
    expect(call.values[0]!.cached_tokens).toBe(2_000);
  });

  it("coalesces only the null rows in a mixed batch, leaving real UUIDs intact", async () => {
    const realUuid = "22222222-2222-2222-2222-222222222222";
    const base = {
      org_id: "o1",
      workspace_id: "w1",
      model: "m",
      provider: "openai" as const,
      input_tokens: 1,
      output_tokens: 0,
      cached_tokens: 0,
      cost_usd_micros: 1,
      duration_ms: 1,
      surface: "ingestion" as const,
      prompt_hash: "h",
      created_at: new Date().toISOString(),
    };
    await mod.insertTokenUsage([
      { ...base, execution_step_id: null },
      { ...base, execution_step_id: realUuid },
    ]);
    const values = (insertMock.mock.calls[0]![0] as { values: TokenUsageRow[] })
      .values;
    expect(values[0]!.execution_step_id).toBe(mod.NIL_UUID);
    expect(values[1]!.execution_step_id).toBe(realUuid);
  });

  it("insertToolInvocation delegates to tool_invocations table with single-element array", async () => {
    const row: ToolInvocationRow = {
      invocation_id: "inv1",
      org_id: "o1",
      workspace_id: "w1",
      capability_name: "send_message",
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
    // insertToolInvocation auto-stamps trace_id/span_id from the active OTEL
    // context (empty strings with no tracer) and principal attribution from
    // the ambient tenant scope (sentinels outside any scope — migration 0023).
    expect(insertMock).toHaveBeenCalledWith({
      table: "tool_invocations",
      values: [
        {
          ...row,
          trace_id: "",
          span_id: "",
          principal_id: mod.NIL_UUID,
          principal_kind: "",
          user_id: mod.NIL_UUID,
        },
      ],
      format: "JSONEachRow",
    });
  });

  // ── Principal attribution stamping (migration 0023) ───────────────────────

  it("stamps principal attribution from the ambient tenant scope onto token_usage rows", async () => {
    const ORG = "00000000-0000-0000-0000-0000000000a1";
    const WS = "00000000-0000-0000-0000-0000000000b2";
    const PRINCIPAL = "00000000-0000-0000-0000-0000000000e5";
    const USER = "00000000-0000-0000-0000-0000000000f6";
    const row: TokenUsageRow = {
      execution_step_id: null,
      org_id: ORG,
      workspace_id: WS,
      model: "claude-sonnet-5",
      provider: "anthropic",
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 0,
      cost_usd_micros: 100,
      duration_ms: 50,
      surface: "api",
      prompt_hash: "abc123def456abc1",
      created_at: new Date().toISOString(),
    };
    // Import tenancy from the SAME (reset) module registry as `mod` — the
    // beforeEach vi.resetModules() gives clickhouse.ts a fresh @oxagen/tenancy
    // instance, so a top-level import here would write to a different ALS.
    const { runInTenantScope } = await import("@oxagen/tenancy");
    await runInTenantScope(
      {
        orgId: ORG,
        workspaceId: WS,
        principalId: PRINCIPAL,
        principalKind: "agent",
        userId: USER,
        capabilityName: "query_ontology",
      },
      () => mod.insertTokenUsage([row]),
    );
    const values = (insertMock.mock.calls[0]![0] as { values: TokenUsageRow[] })
      .values;
    expect(values[0]!.principal_id).toBe(PRINCIPAL);
    expect(values[0]!.principal_kind).toBe("agent");
    expect(values[0]!.user_id).toBe(USER);
    expect(values[0]!.capability_name).toBe("query_ontology");
  });

  it("explicit caller attribution wins over the ambient scope (no spoof-by-scope)", async () => {
    const ORG = "00000000-0000-0000-0000-0000000000a1";
    const WS = "00000000-0000-0000-0000-0000000000b2";
    const EXPLICIT = "33333333-3333-3333-3333-333333333333";
    const row: ToolInvocationRow = {
      invocation_id: "inv2",
      org_id: ORG,
      workspace_id: WS,
      capability_name: "send_message",
      message_id: "m1",
      parent_message_id: null,
      execution_step_id: null,
      status: "completed",
      input_size_bytes: 1,
      output_size_bytes: 1,
      latency_ms: 1,
      error_class: null,
      external_provider: "",
      external_server_id: null,
      risk_level: "low",
      required_approval: 0,
      surface: "api",
      provider: "anthropic",
      created_at: new Date().toISOString(),
      principal_id: EXPLICIT,
    };
    // Same-registry import — see the token_usage stamping test above.
    const { runInTenantScope } = await import("@oxagen/tenancy");
    await runInTenantScope(
      {
        orgId: ORG,
        workspaceId: WS,
        principalId: "00000000-0000-0000-0000-0000000000e5",
        principalKind: "human",
      },
      () => mod.insertToolInvocation(row),
    );
    const values = (
      insertMock.mock.calls[0]![0] as { values: ToolInvocationRow[] }
    ).values;
    expect(values[0]!.principal_id).toBe(EXPLICIT);
    // Unset fields still stamp from the ambient scope.
    expect(values[0]!.principal_kind).toBe("human");
  });

  it("insertAuditEvent delegates to audit_events table", async () => {
    const row: AuditEventRow = {
      occurred_at: new Date().toISOString(),
      event_id: "ae1",
      org_id: "o1",
      workspace_id: "w1",
      capability: "send_message",
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

  it("insertEvalRun delegates to eval_runs and coalesces empty metrics/labels", async () => {
    const row: EvalRunRow = {
      run_id: "run-1",
      agent_name: "oxagen",
      agent_version: "0.6.2",
      model: "claude-sonnet-5",
      harness: "terminal-bench",
      suite: "terminal-bench-2.0",
      graph_code: 1,
      graph_exec: 1,
      graph_mem: 1,
      n_tasks: 2,
      n_passed: 1,
      resolved_rate: 0.5,
    };
    await mod.insertEvalRun(row);
    // metrics/labels are coalesced to {} so the Map columns always get a value.
    expect(insertMock).toHaveBeenCalledWith({
      table: "eval_runs",
      values: [{ metrics: {}, labels: {}, ...row }],
      format: "JSONEachRow",
    });
  });

  it("insertEvalRun preserves caller-supplied metrics/labels", async () => {
    const row: EvalRunRow = {
      run_id: "run-2",
      agent_name: "oxagen",
      agent_version: "0.7.0",
      model: "m",
      harness: "engram-golden",
      suite: "repo-structural-qa",
      resolved_rate: 1,
      metrics: { context_precision: 1, cost_usd: 0.27 },
      labels: { branch: "main" },
    };
    await mod.insertEvalRun(row);
    const call = insertMock.mock.calls[0]![0] as { values: EvalRunRow[] };
    expect(call.values[0]!.metrics).toEqual({
      context_precision: 1,
      cost_usd: 0.27,
    });
    expect(call.values[0]!.labels).toEqual({ branch: "main" });
  });

  it("insertEvalResults delegates to eval_results and coalesces maps per row", async () => {
    const rows: EvalResultRow[] = [
      {
        run_id: "run-1",
        task_id: "gpt2-codegolf",
        harness: "terminal-bench",
        suite: "terminal-bench-2.0",
        agent_name: "oxagen",
        agent_version: "0.6.2",
        model: "m",
        passed: 1,
        reward: 1,
        metrics: { cost_usd: 0.7 },
      },
      {
        run_id: "run-1",
        task_id: "llm-batch",
        harness: "terminal-bench",
        suite: "terminal-bench-2.0",
        agent_name: "oxagen",
        agent_version: "0.6.2",
        model: "m",
        passed: 0,
      },
    ];
    await mod.insertEvalResults(rows);
    expect(insertMock).toHaveBeenCalledWith({
      table: "eval_results",
      values: [
        { metrics: {}, labels: {}, ...rows[0] },
        { metrics: {}, labels: {}, ...rows[1] },
      ],
      format: "JSONEachRow",
    });
  });

  it("insertEvalResults no-ops on an empty array", async () => {
    await mod.insertEvalResults([]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("no-ops when rows array is empty (any insert helper)", async () => {
    await mod.insertExecutionLogs([]);
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
          cache_write_tokens: "50",
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

    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      metric: "tokens_input",
      quantity: 1000,
      costMicros: 0n,
    });
    expect(result[1]).toEqual({
      metric: "tokens_output",
      quantity: 500,
      costMicros: 0n,
    });
    expect(result[2]).toEqual({
      metric: "tokens_cached",
      quantity: 200,
      costMicros: 0n,
    });
    expect(result[3]).toEqual({
      metric: "tokens_cache_write",
      quantity: 50,
      costMicros: 0n,
    });
    expect(result[4]).toEqual({
      metric: "executions",
      quantity: 10,
      costMicros: 150000n,
    });
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

    expect(result[0]).toEqual({
      metric: "tokens_input",
      quantity: 0,
      costMicros: 0n,
    });
    expect(result[1]).toEqual({
      metric: "tokens_output",
      quantity: 0,
      costMicros: 0n,
    });
    expect(result[2]).toEqual({
      metric: "tokens_cached",
      quantity: 0,
      costMicros: 0n,
    });
    expect(result[3]).toEqual({
      metric: "tokens_cache_write",
      quantity: 0,
      costMicros: 0n,
    });
    expect(result[4]).toEqual({
      metric: "executions",
      quantity: 0,
      costMicros: 0n,
    });
  });

  it("strips the trailing Z from ISO date strings in query params", async () => {
    queryMock.mockResolvedValue({
      json: vi
        .fn()
        .mockResolvedValue([
          {
            input_tokens: "0",
            output_tokens: "0",
            cached_tokens: "0",
            cost_micros: "0",
            row_count: "0",
          },
        ]),
    });

    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-02-01T00:00:00.000Z");

    await mod.sumTokenUsage({
      orgId: "o1",
      periodStart: start,
      periodEnd: end,
    });

    const callArgs = queryMock.mock.calls[0]![0];
    // The query replaces trailing Z so ClickHouse DateTime64 can parse
    expect(callArgs.query_params.periodStart).toBe("2026-01-01T00:00:00.000");
    expect(callArgs.query_params.periodEnd).toBe("2026-02-01T00:00:00.000");
    expect(callArgs.query_params.periodStart).not.toMatch(/Z$/);
  });

  it("passes orgId and uses JSONEachRow format", async () => {
    queryMock.mockResolvedValue({
      json: vi
        .fn()
        .mockResolvedValue([
          {
            input_tokens: "0",
            output_tokens: "0",
            cached_tokens: "0",
            cost_micros: "0",
            row_count: "0",
          },
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

    const hash = await mod.latestAuditChainHash({
      orgId: "o1",
      capability: "send_message",
    });
    expect(hash).toBe("abc123def456");
  });

  it("returns empty string when no prior events exist", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });

    const hash = await mod.latestAuditChainHash({
      orgId: "o1",
      capability: "send_message",
    });
    expect(hash).toBe("");
  });

  it("queries audit_events FINAL ordered by occurred_at DESC with LIMIT 1", async () => {
    queryMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue([]),
    });

    await mod.latestAuditChainHash({
      orgId: "org-uuid",
      capability: "test.capability",
    });

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
