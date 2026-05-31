import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbSelectFrom: vi.fn(),
  dbSelectWhere: vi.fn(),
  dbSelect: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdateSet: vi.fn(),
  dbUpdate: vi.fn(),
  invokeCapability: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
}));

// DB SELECT chain: db().select().from().where()
mocks.dbSelectWhere.mockResolvedValue([]);
mocks.dbSelectFrom.mockReturnValue({ where: mocks.dbSelectWhere });
mocks.dbSelect.mockReturnValue({ from: mocks.dbSelectFrom });

// DB UPDATE chain: db().update().set().where()
mocks.dbUpdateWhere.mockResolvedValue(undefined);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });

const fakeDb = {
  select: mocks.dbSelect,
  update: mocks.dbUpdate,
};

vi.mock("@oxagen/database", () => ({
  db: () => fakeDb,
  schema: {
    subagentRuns: { fanoutId: "fanoutId", id: "id" },
    subagentFanouts: { id: "id", orgId: "orgId" },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { and: orig.and, eq: orig.eq };
});

vi.mock("@oxagen/agent", () => ({
  invokeCapability: mocks.invokeCapability,
}));

vi.mock("@oxagen/oxagen", () => ({}));

vi.mock("../inngest.js", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

vi.mock("../logger.js", () => ({
  logger: { info: mocks.loggerInfo, error: vi.fn() },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "evt-test", INNGEST_SIGNING_KEY: "sign-test", NODE_ENV: "test" }),
  normalizeEnv: (e: unknown) => e,
}));

// Capture the handler
let capturedHandler: ((ctx: {
  event: { data: Record<string, unknown> };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>) | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    return {};
  },
);

await import("./agent.execute-subagent.js");

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_EVENT = {
  data: { orgId: "org_1", workspaceId: "ws_1", fanoutId: "fanout_1" },
};

function makeRun(id: string, capabilityName = "agent.memory.recall") {
  return { id, capabilityName, inputPayload: {}, childMessageId: `msg_${id}` };
}

// ─────────────────────────────────────────────────────────────────────────────

import { deriveFanoutStatus } from "./agent.execute-subagent.js";

describe("agentExecuteSubagent Inngest handler", () => {
  beforeEach(() => {
    mocks.dbSelect.mockClear();
    mocks.dbSelectFrom.mockClear();
    mocks.dbSelectWhere.mockClear();
    mocks.dbUpdate.mockClear();
    mocks.dbUpdateSet.mockClear();
    mocks.dbUpdateWhere.mockClear();
    mocks.invokeCapability.mockClear();
    mocks.loggerInfo.mockClear();
    // Restore chain defaults
    mocks.dbSelectWhere.mockResolvedValue([]);
    mocks.dbSelectFrom.mockReturnValue({ where: mocks.dbSelectWhere });
    mocks.dbSelect.mockReturnValue({ from: mocks.dbSelectFrom });
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
  });

  it("returns completed when all children succeed", async () => {
    const runs = [makeRun("r1"), makeRun("r2")];
    mocks.dbSelectWhere.mockResolvedValueOnce(runs);
    mocks.invokeCapability.mockResolvedValue({ ok: true });

    const result = await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const r = result as Record<string, unknown>;
    expect(r.status).toBe("completed");
    expect(r.completed).toBe(2);
    expect(r.fanoutId).toBe("fanout_1");
    expect(mocks.invokeCapability).toHaveBeenCalledTimes(2);
  });

  it("returns failed when all children fail", async () => {
    const runs = [makeRun("r1"), makeRun("r2")];
    mocks.dbSelectWhere.mockResolvedValueOnce(runs);
    mocks.invokeCapability.mockRejectedValue(new Error("child error"));

    const result = await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const r = result as Record<string, unknown>;
    expect(r.status).toBe("failed");
    expect(r.completed).toBe(0);
  });

  it("returns partial when some children succeed and some fail", async () => {
    const runs = [makeRun("r1"), makeRun("r2"), makeRun("r3")];
    mocks.dbSelectWhere.mockResolvedValueOnce(runs);
    // First succeeds, second fails, third succeeds
    mocks.invokeCapability
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("child error"))
      .mockResolvedValueOnce({ ok: true });

    const result = await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const r = result as Record<string, unknown>;
    expect(r.status).toBe("partial");
    expect(r.completed).toBe(2);
  });

  it("returns completed for an empty fanout (zero children)", async () => {
    mocks.dbSelectWhere.mockResolvedValueOnce([]);

    const result = await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const r = result as Record<string, unknown>;
    expect(r.status).toBe("completed");
    expect(r.completed).toBe(0);
    expect(mocks.invokeCapability).not.toHaveBeenCalled();
  });

  it("invokes each child with the correct context (orgId, workspaceId, surface)", async () => {
    const runs = [makeRun("r1", "some.capability")];
    mocks.dbSelectWhere.mockResolvedValueOnce(runs);
    mocks.invokeCapability.mockResolvedValue(null);

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    const [capName, _input, ctx] = mocks.invokeCapability.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(capName).toBe("some.capability");
    expect(ctx.orgId).toBe("org_1");
    expect(ctx.workspaceId).toBe("ws_1");
    expect(ctx.surface).toBe("runner");
    expect(ctx.messageId).toBe("msg_r1");
  });

  it("logs completion with fanoutId, completed count, and status", async () => {
    mocks.dbSelectWhere.mockResolvedValueOnce([]);

    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ fanoutId: "fanout_1", completed: 0, status: "completed" }),
      "agent.execute-subagent complete",
    );
  });
});

describe("deriveFanoutStatus", () => {
  it("returns 'completed' when all children succeed", () => {
    expect(deriveFanoutStatus(3, 3, false)).toBe("completed");
  });

  it("returns 'completed' for empty fanout (zero runs)", () => {
    // 0 === 0, no failures
    expect(deriveFanoutStatus(0, 0, false)).toBe("completed");
  });

  it("returns 'failed' when all children fail (regression: was 'completed' before fix)", () => {
    // completed=0, total=3, anyFailed=true → must be "failed", not "completed"
    expect(deriveFanoutStatus(0, 3, true)).toBe("failed");
  });

  it("returns 'partial' when some children succeed and some fail", () => {
    expect(deriveFanoutStatus(1, 3, true)).toBe("partial");
    expect(deriveFanoutStatus(2, 3, true)).toBe("partial");
  });

  it("returns 'completed' for single successful child", () => {
    expect(deriveFanoutStatus(1, 1, false)).toBe("completed");
  });

  it("returns 'failed' for single failed child (regression case)", () => {
    expect(deriveFanoutStatus(0, 1, true)).toBe("failed");
  });
});
