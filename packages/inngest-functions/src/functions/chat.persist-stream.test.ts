import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbUpdateWhere: vi.fn(),
  dbUpdateSet: vi.fn(),
  dbUpdate: vi.fn(),
  insertTokenUsage: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

mocks.dbUpdateWhere.mockResolvedValue(undefined);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });

const fakeDb = { update: mocks.dbUpdate };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    // withTenantDb pass-through: invokes the callback with the same fake tx so
    // handler assertions keep working without a real transaction or GUC.
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
});

vi.mock("@oxagen/tenancy", () => ({
  // runInTenantScope pass-through: executes fn() directly in unit tests so
  // the tenant scope is satisfied without a real ALS entry.
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertTokenUsage: mocks.insertTokenUsage,
  };
});

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn() },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    INNGEST_EVENT_KEY: "evt-test",
    INNGEST_SIGNING_KEY: "sign-test",
    NODE_ENV: "test",
  }),
  normalizeEnv: (e: unknown) => e,
}));

// Capture the handler
let capturedHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

await import("./chat.persist-stream");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_EVENT = {
  data: {
    orgId: "org_1",
    workspaceId: "ws_1",
    conversationId: "conv_1",
    assistantMessageId: "msg_1",
    content: "Hello!",
    tokenUsage: null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────

describe("chatPersistStream Inngest handler", () => {
  beforeEach(() => {
    mocks.dbUpdate.mockClear();
    mocks.dbUpdateSet.mockClear();
    mocks.dbUpdateWhere.mockClear();
    mocks.insertTokenUsage.mockClear();
    mocks.loggerInfo.mockClear();
    // Restore db chain defaults
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.insertTokenUsage.mockResolvedValue(undefined);
  });

  it("updates the message in Postgres and returns the persisted id", async () => {
    const result = await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    });

    expect(mocks.dbUpdate).toHaveBeenCalledTimes(1);
    const r = result as Record<string, unknown>;
    expect(r.persisted).toBe("msg_1");
  });

  it("skips insertTokenUsage when tokenUsage is null", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.insertTokenUsage).not.toHaveBeenCalled();
  });

  it("calls insertTokenUsage with all required fields when tokenUsage is present", async () => {
    const event = {
      data: {
        ...BASE_EVENT.data,
        tokenUsage: {
          model: "claude-sonnet-5",
          inputTokens: 100,
          outputTokens: 200,
          cachedTokens: 10,
          costMicros: 500,
          // surface propagates the originating surface from the payload; "app"
          // is the correct value for a turn that came from the chat UI.
          surface: "app" as const,
        },
      },
    };

    await capturedHandler!({ event, step: makeStep() });

    expect(mocks.insertTokenUsage).toHaveBeenCalledTimes(1);
    const [rows] = mocks.insertTokenUsage.mock.calls[0] as [
      Array<Record<string, unknown>>,
    ];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("expected exactly one token_usage row");
    expect(row.execution_step_id).toBe("msg_1");
    expect(row.org_id).toBe("org_1");
    expect(row.workspace_id).toBe("ws_1");
    expect(row.model).toBe("claude-sonnet-5");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(200);
    expect(row.cached_tokens).toBe(10);
    expect(row.cost_usd_micros).toBe(500);
    // surface must reflect the originating surface from the event payload, not a constant.
    expect(row.surface).toBe("app");
    // Sentinel values for fields unavailable at this callsite
    expect(row.provider).toBe("");
    expect(row.duration_ms).toBe(0);
    expect(row.prompt_hash).toBe("");
    expect(typeof row.created_at).toBe("string");
  });

  it("logs completion after persisting", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: "msg_1" }),
      "chat.persist-stream complete",
    );
  });
});
