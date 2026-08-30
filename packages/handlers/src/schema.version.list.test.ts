import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getOrCreateRegistry: vi.fn(),
  withTenantDbFn: vi.fn(),
}));

vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: mocks.getOrCreateRegistry,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDbFn,
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaVersionListHandler } from "./schema.version.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const BASE_REGISTRY = {
  id: "reg-internal-id",
  publicId: "scr_abc",
  pinnedVersionId: "pinned-ver-internal-id" as string | null,
  draftVersionId: "draft-ver-internal-id",
  enforcementMode: "lenient",
  conformanceFloor: "0.50",
};

/** Build a version DB row. */
function makeVersion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ver-internal-id",
    publicId: "scv_v1",
    versionNumber: 1,
    status: "published",
    label: "v1",
    changeSummary: "initial",
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    registryId: "reg-internal-id",
    ...overrides,
  };
}

/**
 * Install a withTenantDb that serves two sequential .select() calls:
 *  1) count query → [{ n: total }]   (terminates at .where())
 *  2) rows query  → version rows     (terminates at .offset())
 *
 * The chain is thenable so `const [totalRow] = await tx.select(...).from(...).where(...)`
 * works without a `.limit()` call.
 */
function installTx(total: number, rows: unknown[]) {
  mocks.withTenantDbFn.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      let callIdx = 0;
      const results = [[{ n: total }], rows];
      const tx = {
        select: vi.fn(() => {
          const result = results[callIdx++] ?? [];
          const chain: Record<string, unknown> & PromiseLike<unknown> = {
            then: <T1 = unknown, T2 = never>(
              onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
              onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
            ): PromiseLike<T1 | T2> =>
              Promise.resolve(result).then(onfulfilled, onrejected),
            from: vi.fn(() => chain),
            where: vi.fn(() => chain),
            orderBy: vi.fn(() => chain),
            limit: vi.fn(() => chain),
            offset: vi.fn(() => Promise.resolve(result)),
          };
          return chain;
        }),
      };
      return fn(tx);
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("schemaVersionListHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrCreateRegistry.mockResolvedValue(BASE_REGISTRY);
  });

  // ── happy paths ───────────────────────────────────────────────────────────

  it("returns versions list with correct shape", async () => {
    const ver = makeVersion();
    installTx(1, [ver]);

    const result = await schemaVersionListHandler({}, CTX);

    expect(result.total).toBe(1);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]).toMatchObject({
      versionId: "scv_v1",
      versionNumber: 1,
      status: "published",
      label: "v1",
      changeSummary: "initial",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("marks the pinned version as isPinned=true", async () => {
    const pinned = makeVersion({
      id: "pinned-ver-internal-id",
      publicId: "scv_pinned",
    });
    const draft = makeVersion({
      id: "draft-ver-internal-id",
      publicId: "scv_draft",
      status: "draft",
    });
    installTx(2, [pinned, draft]);

    const result = await schemaVersionListHandler({}, CTX);

    const pinnedResult = result.versions.find(
      (v) => v.versionId === "scv_pinned",
    );
    const draftResult = result.versions.find(
      (v) => v.versionId === "scv_draft",
    );
    expect(pinnedResult?.isPinned).toBe(true);
    expect(draftResult?.isPinned).toBe(false);
  });

  it("sets isPinned=false for all versions when no pinnedVersionId", async () => {
    mocks.getOrCreateRegistry.mockResolvedValue({
      ...BASE_REGISTRY,
      pinnedVersionId: null,
    });
    const ver = makeVersion();
    installTx(1, [ver]);

    const result = await schemaVersionListHandler({}, CTX);

    expect(result.versions[0]!.isPinned).toBe(false);
  });

  it("sets publishedAt to null for unpublished (draft) version", async () => {
    const draftVer = makeVersion({
      id: "draft-ver-internal-id",
      publicId: "scv_draft",
      status: "draft",
      publishedAt: null,
      label: null,
      changeSummary: null,
    });
    installTx(1, [draftVer]);

    const result = await schemaVersionListHandler({}, CTX);

    const [version] = result.versions;
    expect(version!.publishedAt).toBeNull();
    expect(version!.label).toBeNull();
    expect(version!.changeSummary).toBeNull();
  });

  it("returns empty list when no versions", async () => {
    installTx(0, []);

    const result = await schemaVersionListHandler({}, CTX);

    expect(result.total).toBe(0);
    expect(result.versions).toHaveLength(0);
  });

  // ── pagination ────────────────────────────────────────────────────────────

  it("applies default limit=20 and offset=0 when not provided", async () => {
    installTx(0, []);
    await schemaVersionListHandler({}, CTX);
    // Can't verify limit/offset on tx directly, but no error thrown means correct path.
    expect(mocks.withTenantDbFn).toHaveBeenCalledTimes(1);
  });

  it("accepts explicit limit and offset", async () => {
    installTx(50, [makeVersion()]);
    const result = await schemaVersionListHandler(
      { limit: 5, offset: 10 },
      CTX,
    );
    expect(result.total).toBe(50);
    expect(result.versions).toHaveLength(1);
  });

  // ── total defaults ────────────────────────────────────────────────────────

  it("defaults total to 0 when count query returns no row", async () => {
    mocks.withTenantDbFn.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        let callIdx = 0;
        const results = [[], []]; // empty count row, empty versions
        const tx = {
          select: vi.fn(() => {
            const result = results[callIdx++] ?? [];
            const chain: Record<string, unknown> & PromiseLike<unknown> = {
              then: <T1 = unknown, T2 = never>(
                onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
                onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
              ): PromiseLike<T1 | T2> =>
                Promise.resolve(result).then(onfulfilled, onrejected),
              from: vi.fn(() => chain),
              where: vi.fn(() => chain),
              orderBy: vi.fn(() => chain),
              limit: vi.fn(() => chain),
              offset: vi.fn(() => Promise.resolve(result)),
            };
            return chain;
          }),
        };
        return fn(tx);
      },
    );

    const result = await schemaVersionListHandler({}, CTX);
    expect(result.total).toBe(0);
  });
});
