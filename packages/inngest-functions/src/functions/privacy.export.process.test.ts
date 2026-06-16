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
    privacyExportRequests: { id: "export.id" },
  },
}));

vi.mock("drizzle-orm", () => ({ eq: (col: unknown, val: unknown) => ({ col, val }) }));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

type Handler = (ctx: {
  event: { data: unknown };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

const handlers: Record<string, Handler> = {};
mocks.inngestCreateFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: Handler) => {
    handlers[opts.id] = handler;
    return {};
  },
);

await import("./privacy.export.process");

function getHandler(id: string): Handler {
  const handler = handlers[id];
  if (!handler) throw new Error(`handler not registered: ${id}`);
  return handler;
}

function makeStep() {
  return { run: async (_name: string, fn: () => Promise<unknown>) => fn() };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("privacyExportProcess Inngest handler", () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.loggerWarn.mockClear();
  });

  const baseEvent = { exportId: "exp-1", userId: "user-1", orgId: "org-1", scope: "user" as const };

  it("marks processing then fails loud (never marks ready with a placeholder URL)", async () => {
    const handler = getHandler("privacy.export-process");
    expect(handler).toBeDefined();

    await expect(
      handler({ event: { data: baseEvent }, step: makeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    const calls = mocks.updateSet.mock.calls.map((c) => c[0] as { payload: { status?: string; exportUrl?: string } });
    expect(calls.some((c) => c.payload.status === "processing")).toBe(true);
    // CRITICAL: never marked ready, never handed out a placeholder URL
    expect(calls.some((c) => c.payload.status === "ready")).toBe(false);
    expect(calls.some((c) => typeof c.payload.exportUrl === "string")).toBe(false);
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });

  it("error references the tracking ticket OXA-1722", async () => {
    const handler = getHandler("privacy.export-process");
    await expect(handler({ event: { data: baseEvent }, step: makeStep() })).rejects.toThrow(/OXA-1722/);
  });

  it("on-failure handler marks the export failed with the error message", async () => {
    const handler = getHandler("privacy.export-process.on-failure");
    expect(handler).toBeDefined();

    await handler({
      event: { data: { event: { data: { exportId: "exp-1" } }, error: { message: "kaboom" } } },
      step: makeStep(),
    });

    const calls = mocks.updateSet.mock.calls.map((c) => c[0] as { payload: { status?: string; errorMessage?: string } });
    expect(calls.some((c) => c.payload.status === "failed" && c.payload.errorMessage === "kaboom")).toBe(true);
  });

  it("on-failure handler is a no-op when exportId is missing", async () => {
    const handler = getHandler("privacy.export-process.on-failure");
    await handler({ event: { data: { event: { data: {} }, error: "x" } }, step: makeStep() });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
