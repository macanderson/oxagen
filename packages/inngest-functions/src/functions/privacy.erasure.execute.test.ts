import { describe, expect, it, vi, beforeEach } from "vitest";
import { NonRetriableError } from "inngest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateSet: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

// Drizzle tx mock: tx.update(table).set(payload).where(cond) — records every set().
function makeTx() {
  return {
    update: (table: unknown) => ({
      set: (payload: unknown) => {
        mocks.updateSet({ table, payload });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
}
const fakeTx = makeTx();

vi.mock("@oxagen/database", () => ({
  withSystemDb: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
  schema: {
    privacyErasureRequests: { id: "erasure.id" },
    users: { id: "users.id" },
  },
}));

vi.mock("drizzle-orm", () => ({ eq: (col: unknown, val: unknown) => ({ col, val }) }));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

// Capture both handlers (main + on-failure) keyed by their function id.
type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sleep: (name: string, until: string) => Promise<void>;
  };
}) => Promise<unknown>;

const handlers: Record<string, Handler> = {};
mocks.inngestCreateFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: Handler) => {
    handlers[opts.id] = handler;
    return {};
  },
);

await import("./privacy.erasure.execute");

function getHandler(id: string): Handler {
  const handler = handlers[id];
  if (!handler) throw new Error(`handler not registered: ${id}`);
  return handler;
}

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sleep: vi.fn(async () => undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("privacyErasureExecute Inngest handler", () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.loggerInfo.mockClear();
    mocks.loggerWarn.mockClear();
    mocks.loggerError.mockClear();
  });

  const baseEvent = {
    requestId: "req-1",
    userId: "user-1",
    orgId: "org-1",
    scope: "user" as const,
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };

  it("anonymises the user PII row then fails loud (never marks completed)", async () => {
    const handler = getHandler("privacy.erasure-execute");
    expect(handler).toBeDefined();

    await expect(
      handler({ event: { data: baseEvent }, step: makeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    const calls = mocks.updateSet.mock.calls.map((c) => c[0] as { table: unknown; payload: { status?: string; email?: string } });
    // processing transition happened
    expect(calls.some((c) => c.payload.status === "processing")).toBe(true);
    // user record was anonymised
    expect(
      calls.some((c) => c.payload.email === "user-1@deleted.invalid"),
    ).toBe(true);
    // CRITICAL: never marked completed
    expect(calls.some((c) => c.payload.status === "completed")).toBe(false);
  });

  it("fails loud for org scope without touching the users table", async () => {
    const handler = getHandler("privacy.erasure-execute");
    await expect(
      handler({
        event: { data: { ...baseEvent, scope: "org" } },
        step: makeStep(),
      }),
    ).rejects.toThrow(/OXA-1721/);

    const calls = mocks.updateSet.mock.calls.map((c) => c[0] as { table: unknown });
    expect(calls.some((c) => c.table === "users-table-sentinel")).toBe(false);
    expect(calls.some((c) => (c as { table: { id?: string } }).table.id === "users.id")).toBe(false);
  });

  it("on-failure handler marks the request failed with the error message", async () => {
    const handler = getHandler("privacy.erasure-execute.on-failure");
    expect(handler).toBeDefined();

    await handler({
      event: {
        data: {
          event: { data: { requestId: "req-1" } },
          error: { message: "boom" },
        },
      },
      step: makeStep(),
    });

    const calls = mocks.updateSet.mock.calls.map((c) => c[0] as { payload: { status?: string; errorMessage?: string } });
    expect(calls.some((c) => c.payload.status === "failed" && c.payload.errorMessage === "boom")).toBe(true);
  });

  it("on-failure handler is a no-op when requestId is missing", async () => {
    const handler = getHandler("privacy.erasure-execute.on-failure");
    await handler({ event: { data: { event: { data: {} }, error: "x" } }, step: makeStep() });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
