import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
  };
});

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./mcp.tool-snapshot-retention");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("mcpToolSnapshotRetention Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns purgedSnapshots: 0 when no expired snapshots exist", async () => {
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const fakeTx = {
          execute: vi.fn().mockResolvedValue([]),
        };
        return fn(fakeTx);
      },
    );

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ purgedSnapshots: 0 });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ purgedSnapshots: 0 }),
      expect.any(String),
    );
  });

  it("returns purgedSnapshots: N when expired snapshots are deleted", async () => {
    const deletedRows = [{ id: "snap-1" }, { id: "snap-2" }, { id: "snap-3" }];
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const fakeTx = {
          execute: vi.fn().mockResolvedValue(deletedRows),
        };
        return fn(fakeTx);
      },
    );

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ purgedSnapshots: 3 });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ purgedSnapshots: 3 }),
      expect.any(String),
    );
  });

  it("propagates DB errors from the purge query", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("DB connection lost"));

    await expect(capturedHandler!({ step: makeStep() })).rejects.toThrow(
      "DB connection lost",
    );
  });

  it("logs the cutoff ISO string and duration on success", async () => {
    mocks.withSystemDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => {
        const fakeTx = {
          execute: vi.fn().mockResolvedValue([{ id: "snap-1" }]),
        };
        return fn(fakeTx);
      },
    );

    await capturedHandler!({ step: makeStep() });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        cutoffISO: expect.any(String),
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
  });
});
