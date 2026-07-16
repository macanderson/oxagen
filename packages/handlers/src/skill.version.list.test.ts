import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues three withTenantDb calls in order:
//   1. skill lookup     → select(...).from(...).where(...).limit(1)
//   2. count            → select({ total: count() }).from(...).where(...)   (terminates at .where)
//   3. version page     → select(...).from(...).leftJoin(users).where(...).orderBy(...).limit(...).offset(...)
// We queue one result per withTenantDb call; each tx stub resolves every
// terminal method the handler may call to the next queued result.
const mocks = vi.hoisted(() => ({
  dbCallResults: [] as Array<unknown | (() => unknown)>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const queued = mocks.dbCallResults.shift();
      // Resolve the queued entry exactly ONCE per withTenantDb call, lazily.
      // Memoizing the promise ensures the awaitable `where` base and the
      // terminal methods (.limit / .orderBy().limit().offset()) share the same
      // promise — so a queued rejection is created only when actually consumed
      // and never orphaned into an unhandled rejection.
      let pending: Promise<unknown> | undefined;
      const resolve = (): Promise<unknown> => {
        if (!pending) {
          pending = Promise.resolve(
            typeof queued === "function" ? (queued as () => unknown)() : queued,
          );
        }
        return pending;
      };
      const tx = {
        select: () => ({
          from: () => {
            // `where` must be BOTH awaitable (count query terminates here)
            // AND callable-returning-a-builder (skill lookup → .limit, version
            // page → .orderBy().limit().offset()). A thenable defers resolution
            // until awaited so unconsumed branches never create a rejection.
            const whereResult = {
              then: (
                onFulfilled?: ((value: unknown) => unknown) | null,
                onRejected?: ((reason: unknown) => unknown) | null,
              ) => resolve().then(onFulfilled, onRejected),
              limit: () => resolve(),
              orderBy: () => ({
                limit: () => ({
                  offset: () => resolve(),
                }),
              }),
            };
            const whereFn = () => whereResult;
            // The version-page query LEFT JOINs users for the author email
            // before .where(); route it back to the same where builder.
            return { where: whereFn, leftJoin: () => ({ where: whereFn }) };
          },
        }),
      };
      return fn(tx);
    },
  };
});

import { skillVersionListHandler } from "./skill.version.list";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

const SKILL_ROW = {
  id: "uuid-skill-1",
  publicId: "skl_abc",
  activeVersionId: "uuid-ver-2",
};

const makeVersionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "uuid-ver-2",
  publicId: "slv_002",
  versionNumber: 2,
  isLatest: true,
  changeSummary: null,
  createdAt: new Date("2024-06-01T00:00:00.000Z"),
  createdByUserId: "u_1",
  createdByEmail: "u1@example.com",
  ...overrides,
});

/** Queue the three withTenantDb results (skill, count, versions) for one call sequence. */
function enqueue(skill: unknown, count: unknown, versions: unknown): void {
  mocks.dbCallResults.length = 0;
  mocks.dbCallResults.push(
    () => Promise.resolve(skill),
    () => Promise.resolve(count),
    () => Promise.resolve(versions),
  );
}

/** Queue a rejection thunk in a specific slot. */
function rejectAt(index: number, error: Error, ...rest: unknown[][]): void {
  mocks.dbCallResults.length = 0;
  for (let i = 0; i < index; i += 1) {
    mocks.dbCallResults.push(() => Promise.resolve(rest[i] ?? []));
  }
  mocks.dbCallResults.push(() => Promise.reject(error));
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("skillVersionListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueue([SKILL_ROW], [{ total: 1 }], [makeVersionRow()]);
  });

  it("returns empty result when skill not found", async () => {
    enqueue([], [{ total: 0 }], []);
    const result = await skillVersionListHandler(
      { skill_id: "skl_unknown", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.versions).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.skill_id).toBe("skl_unknown");
  });

  it("returns version list with correct shape", async () => {
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.skill_id).toBe("skl_abc");
    expect(result.versions).toHaveLength(1);
    const v = result.versions[0]!;
    expect(v.id).toBe("slv_002");
    expect(v.versionNumber).toBe(2);
    expect(v.isLatest).toBe(true);
    expect(v.isActive).toBe(true); // matches activeVersionId
    expect(v.changeSummary).toBeNull();
    expect(v.createdBy).toBe("u_1");
    expect(v.createdByEmail).toBe("u1@example.com");
    expect(typeof v.createdAt).toBe("string");
    expect(result.total).toBe(1);
  });

  it("passes through changeSummary and null createdByEmail", async () => {
    enqueue(
      [SKILL_ROW],
      [{ total: 1 }],
      [
        makeVersionRow({
          changeSummary: "tighten wording",
          createdByEmail: null,
        }),
      ],
    );
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.versions[0]!.changeSummary).toBe("tighten wording");
    expect(result.versions[0]!.createdByEmail).toBeNull();
  });

  it("marks isActive=false when version does not match active_version_id", async () => {
    enqueue(
      [SKILL_ROW],
      [{ total: 1 }],
      [
        makeVersionRow({
          id: "uuid-ver-1",
          publicId: "slv_001",
          versionNumber: 1,
          isLatest: false,
        }),
      ],
    );
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.versions[0]!.isActive).toBe(false);
  });

  it("marks isActive=false when skill has no activeVersionId", async () => {
    enqueue(
      [{ ...SKILL_ROW, activeVersionId: null }],
      [{ total: 1 }],
      [makeVersionRow()],
    );
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.versions[0]!.isActive).toBe(false);
  });

  it("returns null createdBy when createdByUserId is null", async () => {
    enqueue(
      [SKILL_ROW],
      [{ total: 1 }],
      [makeVersionRow({ createdByUserId: null })],
    );
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.versions[0]!.createdBy).toBeNull();
  });

  it("returns multiple versions when DB has multiple rows", async () => {
    enqueue(
      [SKILL_ROW],
      [{ total: 3 }],
      [
        makeVersionRow({
          id: "uuid-ver-3",
          publicId: "slv_003",
          versionNumber: 3,
          isLatest: true,
        }),
        makeVersionRow({
          id: "uuid-ver-2",
          publicId: "slv_002",
          versionNumber: 2,
          isLatest: false,
        }),
        makeVersionRow({
          id: "uuid-ver-1",
          publicId: "slv_001",
          versionNumber: 1,
          isLatest: false,
        }),
      ],
    );
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.versions).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.versions[0]!.versionNumber).toBe(3);
    expect(result.versions[2]!.versionNumber).toBe(1);
  });

  it("returns total=0 when count row is absent", async () => {
    enqueue([SKILL_ROW], [], [makeVersionRow()]);
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    expect(result.total).toBe(0);
  });

  it("propagates DB error from skill lookup", async () => {
    rejectAt(0, new Error("DB connection failed"));
    await expect(
      skillVersionListHandler(
        { skill_id: "skl_abc", limit: 20, offset: 0 },
        CTX,
      ),
    ).rejects.toThrow("DB connection failed");
  });

  it("propagates DB error from count query", async () => {
    rejectAt(1, new Error("count query failed"), [SKILL_ROW]);
    await expect(
      skillVersionListHandler(
        { skill_id: "skl_abc", limit: 20, offset: 0 },
        CTX,
      ),
    ).rejects.toThrow("count query failed");
  });

  it("propagates DB error from version page query", async () => {
    rejectAt(2, new Error("version page failed"), [SKILL_ROW], [{ total: 1 }]);
    await expect(
      skillVersionListHandler(
        { skill_id: "skl_abc", limit: 20, offset: 0 },
        CTX,
      ),
    ).rejects.toThrow("version page failed");
  });

  it("tenant isolation: skill from different workspace returns empty", async () => {
    enqueue([], [{ total: 0 }], []);
    const alienCtx: CapabilityContext = makeCTX({
      workspaceId: "ws_other",
      orgId: "org_other",
    });
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      alienCtx,
    );
    expect(result.versions).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("createdAt is serialized as ISO 8601 string", async () => {
    const result = await skillVersionListHandler(
      { skill_id: "skl_abc", limit: 20, offset: 0 },
      CTX,
    );
    const ts = result.versions[0]!.createdAt;
    expect(new Date(ts).getTime()).not.toBeNaN();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
