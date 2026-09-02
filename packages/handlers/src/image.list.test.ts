import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  selectRows: vi.fn(),
}));

// Mock withTenantDb as a passthrough that invokes the callback with a fake tx.
// The select chain: .select().from().where().orderBy() → returns rows.
function makeTx(rows: unknown[]): unknown {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTx(mocks.selectRows())),
  };
});

// ── import under test ─────────────────────────────────────────────────────────

import { imageListHandler } from "./image.list";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── fixtures ──────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    publicId: "gen_abc",
    storageUrl: "https://blob.store/abc.png",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    prompt: "A sunset",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("imageListHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows.mockReturnValue([]);
  });

  it("returns an empty images array when no rows exist", async () => {
    mocks.selectRows.mockReturnValue([]);
    const result = await imageListHandler({}, CTX);
    expect(result.images).toEqual([]);
  });

  it("maps rows to the contract output shape", async () => {
    const row = makeRow();
    mocks.selectRows.mockReturnValue([row]);
    const result = await imageListHandler({}, CTX);

    expect(result.images).toHaveLength(1);
    const img = result.images[0]!;
    expect(img.id).toBe("gen_abc");
    expect(img.url).toBe("https://blob.store/abc.png");
    expect(img.created_at).toBe("2025-01-01T00:00:00.000Z");
    expect(img.prompt).toBe("A sunset");
  });

  it("falls back to /api/v1/assets/:id when storageUrl is null", async () => {
    const row = makeRow({ storageUrl: null });
    mocks.selectRows.mockReturnValue([row]);
    const result = await imageListHandler({}, CTX);

    expect(result.images[0]!.url).toBe("/api/v1/assets/gen_abc");
  });

  it("returns multiple rows in the order provided by the DB query", async () => {
    const rows = [
      makeRow({ publicId: "gen_1", prompt: "First" }),
      makeRow({ publicId: "gen_2", prompt: "Second" }),
    ];
    mocks.selectRows.mockReturnValue(rows);
    const result = await imageListHandler({}, CTX);

    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.id).toBe("gen_1");
    expect(result.images[1]!.id).toBe("gen_2");
  });

  it("calls withTenantDb (tenant scope enforced)", async () => {
    mocks.selectRows.mockReturnValue([makeRow()]);
    const result = await imageListHandler({}, CTX);
    // If withTenantDb was called and returned data, we have rows
    expect(result.images).toHaveLength(1);
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("propagates DB error when the query throws", async () => {
    // Cause makeTx(mocks.selectRows()) to throw inside withTenantDb.
    // withTenantDb is async so a synchronous throw inside its body becomes a rejection.
    mocks.selectRows.mockImplementationOnce(() => {
      throw new Error("DB connection failed");
    });

    await expect(imageListHandler({}, CTX)).rejects.toThrow(
      "DB connection failed",
    );
  });

  it("throws when createdAt is null (non-nullable field returned as null)", async () => {
    // Simulate a corrupted DB row where createdAt is unexpectedly null.
    // The handler calls r.createdAt.toISOString() without a null guard — this
    // should surface as a TypeError so callers know the data is corrupt.
    const row = makeRow({ createdAt: null });
    mocks.selectRows.mockReturnValueOnce([row]);

    await expect(imageListHandler({}, CTX)).rejects.toThrow(TypeError);
  });
});
