import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  storageDelete: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {},
}));

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ driver: "vercel-blob", delete: mocks.storageDelete }),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: strings.join("?"),
      values,
    })),
    { param: (value: unknown) => ({ param: value }) },
  );
  return { ...actual, sql };
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
let capturedOpts: unknown = null;
let capturedTrigger: unknown = null;

mocks.createFunction.mockImplementation(
  (opts: unknown, trigger: unknown, handler: HandlerFn) => {
    capturedOpts = opts;
    capturedTrigger = trigger;
    capturedHandler = handler;
    return [{}];
  },
);

const { UNSENT_ATTACHMENT_TTL_MS } = await import(
  "./assistant.attachment-sweep"
);

function handler(): HandlerFn {
  if (!capturedHandler) throw new Error("the sweep registered no handler");
  return capturedHandler;
}

function makeStep(names: string[] = []): StepCtx {
  return {
    run: async (name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      return fn();
    },
  };
}

type Query = { text: string; values: unknown[] };

/**
 * A system transaction whose first execute answers each batch's select with
 * the next list of rows, and records every statement.
 */
function fakeDb(batches: { id: string; storage_key: string }[][]) {
  const statements: Query[] = [];
  let batch = 0;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => unknown) => {
      const rows = batches[batch] ?? [];
      batch++;
      const tx = {
        execute: vi.fn(async (query: Query) => {
          statements.push(query);
          return query.text.includes("SELECT") ? rows : [];
        }),
      };
      return fn(tx);
    },
  );
  return statements;
}

function rows(count: number, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(from + i).padStart(12, "0")}`,
    storage_key: `attachments/org/ws/${String(from + i)}.txt`,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────

describe("assistantAttachmentSweep Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storageDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs every hour, one run at a time", () => {
    expect(capturedOpts).toEqual(
      expect.objectContaining({
        id: "assistant.attachment-sweep",
        concurrency: { limit: 1 },
      }),
    );
    expect(capturedTrigger).toEqual({ cron: "0 * * * *" });
  });

  it("deletes nothing and takes one batch when every upload was sent", async () => {
    const statements = fakeDb([[]]);

    const result = await handler()({ step: makeStep() });

    expect(result).toEqual({ deleted: 0, failed: 0, batches: 1 });
    expect(mocks.storageDelete).not.toHaveBeenCalled();
    expect(statements.some((s) => s.text.includes("DELETE"))).toBe(false);
  });

  it("selects only unlinked uploads on this store older than a day, locking them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const statements = fakeDb([[]]);

    await handler()({ step: makeStep() });

    const [select] = statements;
    expect(select?.text).toContain("source = 'user_upload'");
    expect(select?.text).toContain("storage_key LIKE 'attachments/%'");
    expect(select?.text).toContain("conversation_id IS NULL");
    expect(select?.text).toContain("FOR UPDATE SKIP LOCKED");
    expect(select?.values).toContain("vercel-blob");
    expect(select?.values).toContain(
      new Date(Date.now() - UNSENT_ATTACHMENT_TTL_MS).toISOString(),
    );
    expect(UNSENT_ATTACHMENT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("deletes each unsent file's bytes, then its row", async () => {
    const stale = rows(2);
    const statements = fakeDb([stale]);

    const result = await handler()({ step: makeStep() });

    expect(mocks.storageDelete.mock.calls).toEqual([
      ["attachments/org/ws/0.txt"],
      ["attachments/org/ws/1.txt"],
    ]);
    const del = statements.find((s) => s.text.includes("DELETE"));
    expect(del?.values).toEqual([{ param: stale.map((r) => r.id) }]);
    expect(result).toEqual({ deleted: 2, failed: 0, batches: 1 });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: 2, failed: 0 }),
      expect.any(String),
    );
  });

  it("keeps the row of a file the store refuses to delete, and stops the run (negative)", async () => {
    const stale = rows(100);
    const statements = fakeDb([stale, rows(100, 100)]);
    mocks.storageDelete.mockImplementation(async (key: string) => {
      if (key === "attachments/org/ws/1.txt") throw new Error("blob store down");
    });

    const names: string[] = [];
    const result = await handler()({ step: makeStep(names) });

    const del = statements.find((s) => s.text.includes("DELETE"));
    const deletedIds = (del?.values[0] as { param: string[] }).param;
    expect(deletedIds).toHaveLength(99);
    expect(deletedIds).not.toContain(stale[1]?.id);
    expect(result).toEqual({ deleted: 99, failed: 1, batches: 1 });
    expect(names).toEqual(["sweep-batch-0"]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: stale[1]?.id, err: "blob store down" }),
      expect.any(String),
    );
  });

  it("takes another batch while each one comes back full, and stops at a short one", async () => {
    fakeDb([rows(100), rows(100, 100), rows(3, 200)]);

    const names: string[] = [];
    const result = await handler()({ step: makeStep(names) });

    expect(names).toEqual(["sweep-batch-0", "sweep-batch-1", "sweep-batch-2"]);
    expect(result).toEqual({ deleted: 203, failed: 0, batches: 3 });
  });

  it("stops after ten full batches and leaves the rest for the next hour", async () => {
    fakeDb(Array.from({ length: 12 }, (_, i) => rows(100, i * 100)));

    const names: string[] = [];
    const result = await handler()({ step: makeStep(names) });

    expect(names).toHaveLength(10);
    expect(result).toEqual({ deleted: 1000, failed: 0, batches: 10 });
  });
});
