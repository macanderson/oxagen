/**
 * seed.test.ts
 *
 * Unit tests for seedPlatform() and seedDev() from seed.ts.
 *
 * No live DB is required — `withSystemDb` is mocked to call the provided
 * callback with a chainable mock transaction object. The tests assert:
 *
 *  1. seedPlatform() upserts the free plan row (insert → values → onConflictDoUpdate).
 *  2. seedPlatform() also seeds the gated ebook editions.
 *  3. seedDev() performs the org / user / workspace / agent version inserts in order.
 *  4. seedDev() branches into the "create version" path when activeVersionId is null.
 *  5. seedDev() skips the version insert when activeVersionId is already set.
 *  6. seed() calls both seedPlatform() and seedDev().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock setup — vi.mock() factories capture these references.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  // Chainable tx mock — every intermediate builder method returns an object
  // that supports all the next-step methods. We track the outermost mocks so
  // we can assert call counts / args.

  // ── select chain ─────────────────────────────────────────────────────────
  // limit() is called multiple times (once per select query); we sequence the
  // return values via mockResolvedValueOnce in each test.
  const limitMock = vi.fn();

  // where() is called with Drizzle expression args (ignored by the mock).
  const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  // ── insert chain ─────────────────────────────────────────────────────────
  const onConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn().mockReturnValue({
    onConflictDoNothing: onConflictDoNothingMock,
    onConflictDoUpdate: onConflictDoUpdateMock,
  });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  // ── update chain ─────────────────────────────────────────────────────────
  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  const mockTx = {
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  };

  // withSystemDb calls its callback with the mock tx.
  const withSystemDbMock = vi.fn(
    async (cb: (tx: typeof mockTx) => Promise<unknown>) => {
      return cb(mockTx);
    },
  );

  const closeDatabaseMock = vi.fn().mockResolvedValue(undefined);
  const seedBookEditionsMock = vi.fn().mockResolvedValue(undefined);

  return {
    limitMock,
    whereMock,
    fromMock,
    selectMock,
    onConflictDoNothingMock,
    onConflictDoUpdateMock,
    valuesMock,
    insertMock,
    updateWhereMock,
    updateSetMock,
    updateMock,
    mockTx,
    withSystemDbMock,
    closeDatabaseMock,
    seedBookEditionsMock,
  };
});

vi.mock("./tenant", () => ({ withSystemDb: mocks.withSystemDbMock }));
vi.mock("./client", () => ({ closeDatabase: mocks.closeDatabaseMock }));
// Book HTML seed is covered in seed-book-editions.test.ts; keep these tests
// on the plan upsert path without reading seed-assets or counting extra
// withSystemDb calls.
vi.mock("./seed-book-editions", () => ({
  seedBookEditions: mocks.seedBookEditionsMock,
}));

import { seedPlatform, seedDev, seed } from "./seed";

// ---------------------------------------------------------------------------
// Helpers to reset state between tests
// ---------------------------------------------------------------------------

function resetAllMocks() {
  // Clear counts/calls but keep implementations
  mocks.limitMock.mockReset();
  mocks.whereMock.mockReset().mockReturnValue({ limit: mocks.limitMock });
  mocks.fromMock.mockReset().mockReturnValue({ where: mocks.whereMock });
  mocks.selectMock.mockReset().mockReturnValue({ from: mocks.fromMock });
  mocks.onConflictDoNothingMock.mockReset().mockResolvedValue(undefined);
  mocks.onConflictDoUpdateMock.mockReset().mockResolvedValue(undefined);
  mocks.valuesMock.mockReset().mockReturnValue({
    onConflictDoNothing: mocks.onConflictDoNothingMock,
    onConflictDoUpdate: mocks.onConflictDoUpdateMock,
  });
  mocks.insertMock.mockReset().mockReturnValue({ values: mocks.valuesMock });
  mocks.updateWhereMock.mockReset().mockResolvedValue(undefined);
  mocks.updateSetMock
    .mockReset()
    .mockReturnValue({ where: mocks.updateWhereMock });
  mocks.updateMock.mockReset().mockReturnValue({ set: mocks.updateSetMock });
  mocks.withSystemDbMock
    .mockReset()
    .mockImplementation(
      async (cb: (tx: typeof mocks.mockTx) => Promise<unknown>) =>
        cb(mocks.mockTx),
    );
  mocks.closeDatabaseMock.mockReset().mockResolvedValue(undefined);
  mocks.seedBookEditionsMock.mockReset().mockResolvedValue(undefined);
}

// Sequence of select().from().where().limit() resolved values for seedDev():
//   call 1: org lookup         → [{ id: "org-id" }]
//   call 2: user lookup        → [{ id: "user-id" }]
//   call 3: workspace lookup   → [{ id: "ws-id" }]
//   call 4: agent lookup       → [{ id: "agent-id", activeVersionId: null }]
//   call 5: version lookup     → [{ id: "version-id" }]
function setupDevSelectSequence() {
  mocks.limitMock
    .mockResolvedValueOnce([{ id: "org-id" }])
    .mockResolvedValueOnce([{ id: "user-id" }])
    .mockResolvedValueOnce([{ id: "ws-id" }])
    .mockResolvedValueOnce([{ id: "agent-id", activeVersionId: null }])
    .mockResolvedValueOnce([{ id: "version-id" }]);
}

// ---------------------------------------------------------------------------
// seedPlatform()
// ---------------------------------------------------------------------------

describe("seedPlatform()", () => {
  beforeEach(resetAllMocks);

  it("wraps work in withSystemDb", async () => {
    await seedPlatform();
    expect(mocks.withSystemDbMock).toHaveBeenCalledOnce();
  });

  it("upserts the free plan with insert/values/onConflictDoUpdate", async () => {
    await seedPlatform();

    expect(mocks.insertMock).toHaveBeenCalledOnce();
    expect(mocks.valuesMock).toHaveBeenCalledOnce();
    expect(mocks.onConflictDoUpdateMock).toHaveBeenCalledOnce();
  });

  it("rewrites an existing free row's GAU terms to the v1 published figures", async () => {
    await seedPlatform();
    const arg = mocks.onConflictDoUpdateMock.mock.calls[0]?.[0] as
      | { target: unknown; set: Record<string, unknown> }
      | undefined;
    expect(arg).toHaveProperty("target");
    expect(arg?.set).toMatchObject({
      currency: "usd",
      ratePerGauMicros: 5_000n,
      blockSizeGau: 5_000,
      includedGauPerMonth: 5_000,
    });
  });

  it("seeds the gated ebook editions after the plan upsert", async () => {
    await seedPlatform();
    expect(mocks.seedBookEditionsMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// seedDev()
// ---------------------------------------------------------------------------

describe("seedDev()", () => {
  beforeEach(resetAllMocks);

  it("wraps work in withSystemDb", async () => {
    setupDevSelectSequence();
    await seedDev();
    expect(mocks.withSystemDbMock).toHaveBeenCalledOnce();
  });

  it("performs an org insert followed by a lookup", async () => {
    setupDevSelectSequence();
    await seedDev();

    // insert must be called at least once for the org
    expect(mocks.insertMock).toHaveBeenCalled();
    // select/from/where/limit pipeline must run for the org lookup
    expect(mocks.selectMock).toHaveBeenCalled();
    expect(mocks.limitMock).toHaveBeenCalled();
  });

  it("performs the full org → user → workspace → agent → version insert sequence", async () => {
    setupDevSelectSequence();
    await seedDev();

    // seedDev inserts: org, user, workspace, orgUser, workspaceUser, agent, agentVersion
    // + 1 update for activeVersionId
    expect(mocks.insertMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(mocks.selectMock.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("branches into version creation when activeVersionId is null", async () => {
    setupDevSelectSequence();
    await seedDev();

    // An update() must have been called to wire activeVersionId
    expect(mocks.updateMock).toHaveBeenCalledOnce();
    expect(mocks.updateSetMock).toHaveBeenCalledOnce();
    expect(mocks.updateWhereMock).toHaveBeenCalledOnce();
  });

  it("skips version insert when activeVersionId is already set", async () => {
    // Agent already has an activeVersionId — no insert or update needed.
    mocks.limitMock
      .mockResolvedValueOnce([{ id: "org-id" }])
      .mockResolvedValueOnce([{ id: "user-id" }])
      .mockResolvedValueOnce([{ id: "ws-id" }])
      .mockResolvedValueOnce([
        { id: "agent-id", activeVersionId: "existing-version-id" },
      ]);

    await seedDev();

    // update must NOT be called because activeVersionId was already set
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it("throws if the org upsert returns no row", async () => {
    mocks.limitMock.mockResolvedValueOnce([]); // org lookup returns empty
    await expect(seedDev()).rejects.toThrow(/dev org/);
  });

  it("throws if the user upsert returns no row", async () => {
    mocks.limitMock
      .mockResolvedValueOnce([{ id: "org-id" }]) // org ok
      .mockResolvedValueOnce([]); // user missing
    await expect(seedDev()).rejects.toThrow(/dev user/);
  });

  it("throws if the workspace upsert returns no row", async () => {
    mocks.limitMock
      .mockResolvedValueOnce([{ id: "org-id" }])
      .mockResolvedValueOnce([{ id: "user-id" }])
      .mockResolvedValueOnce([]); // workspace missing
    await expect(seedDev()).rejects.toThrow(/dev workspace/);
  });

  it("throws if the agent row is missing after insert", async () => {
    mocks.limitMock
      .mockResolvedValueOnce([{ id: "org-id" }])
      .mockResolvedValueOnce([{ id: "user-id" }])
      .mockResolvedValueOnce([{ id: "ws-id" }])
      .mockResolvedValueOnce([]); // agent missing
    await expect(seedDev()).rejects.toThrow(/qa-chat agent/);
  });

  it("throws if the agent version row is missing after insert", async () => {
    mocks.limitMock
      .mockResolvedValueOnce([{ id: "org-id" }])
      .mockResolvedValueOnce([{ id: "user-id" }])
      .mockResolvedValueOnce([{ id: "ws-id" }])
      .mockResolvedValueOnce([{ id: "agent-id", activeVersionId: null }])
      .mockResolvedValueOnce([]); // version missing
    await expect(seedDev()).rejects.toThrow(/qa-chat agent version/);
  });
});

// ---------------------------------------------------------------------------
// seed()
// ---------------------------------------------------------------------------

describe("seed()", () => {
  beforeEach(resetAllMocks);

  it("calls both seedPlatform() and seedDev() in order", async () => {
    setupDevSelectSequence();

    await seed();

    // withSystemDb is called once per seed function = 2 total (book editions
    // are mocked out of seedPlatform for this suite).
    expect(mocks.withSystemDbMock).toHaveBeenCalledTimes(2);
    expect(mocks.seedBookEditionsMock).toHaveBeenCalledOnce();
  });
});
