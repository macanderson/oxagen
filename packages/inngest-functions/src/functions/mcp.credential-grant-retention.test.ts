/**
 * mcp.credential-grant-retention — the credential broker's log is bounded.
 *
 * The broker mints one grant per server per materialization, so the table grows
 * on the order of a thousand rows a day for a modest tenant, with a one-hour
 * TTL and nothing that ever deleted a row. `list_credential_grants` pages over
 * all of them. This weekly cron deletes grants 90 days past the point they
 * stopped being live, in bounded batches.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

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

vi.mock("../logger", () => ({ logger: mocks.logger }));

type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};
type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;
let capturedTrigger: unknown = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, trigger: unknown, handler: HandlerFn) => {
    capturedTrigger = trigger;
    capturedHandler = handler;
    return [{}];
  },
);

const mod = await import("./mcp.credential-grant-retention");

const makeStep = (): StepCtx => ({
  run: async (_name: string, fn: () => Promise<unknown>) => fn(),
});

/** A tx whose execute answers each canned batch in turn. */
function txOverBatches(batches: Array<Array<{ id: string }>>) {
  const execute = vi.fn(async () => batches.shift() ?? []);
  mocks.withSystemDb.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ execute }),
  );
  return execute;
}

describe("mcpCredentialGrantRetention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs weekly", () => {
    expect(capturedTrigger).toEqual({ cron: "30 4 * * 0" });
  });

  it("keeps a grant for 90 days past the point it stopped being live", () => {
    expect(mod.GRANT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("returns purgedGrants: 0 when nothing is past retention", async () => {
    const execute = txOverBatches([[]]);

    expect(await capturedHandler!({ step: makeStep() })).toEqual({
      purgedGrants: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ purgedGrants: 0 }),
      expect.any(String),
    );
  });

  it("keeps deleting while a batch comes back full, then stops", async () => {
    // Two full batches then a short one: three statements, no fourth.
    const full = Array.from({ length: 5_000 }, (_, i) => ({ id: `g${i}` }));
    const execute = txOverBatches([full, full, [{ id: "last" }]]);

    expect(await capturedHandler!({ step: makeStep() })).toEqual({
      purgedGrants: 10_001,
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("stops after one statement when the first batch is short", async () => {
    const execute = txOverBatches([[{ id: "g1" }, { id: "g2" }]]);

    expect(await capturedHandler!({ step: makeStep() })).toEqual({
      purgedGrants: 2,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates a database error rather than reporting a clean purge", async () => {
    mocks.withSystemDb.mockRejectedValue(new Error("DB connection lost"));
    await expect(capturedHandler!({ step: makeStep() })).rejects.toThrow(
      "DB connection lost",
    );
  });

  it("logs the cutoff and the duration", async () => {
    txOverBatches([[{ id: "g1" }]]);
    await capturedHandler!({ step: makeStep() });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        purgedGrants: 1,
        cutoffISO: expect.any(String),
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
  });
});
