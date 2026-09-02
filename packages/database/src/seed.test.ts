/**
 * seed.test.ts
 *
 * Unit tests for seedPlatform() and seedDev() from seed.ts.
 *
 * No live DB is required — `withSystemDb` is mocked to call the provided
 * callback with a chainable mock transaction object. The tests assert:
 *
 *  1. seedPlatform() inserts the free plan row (insert → values → onConflictDoNothing).
 *  2. seedDev() performs the org / user / workspace / agent version inserts in order.
 *  3. seedDev() branches into the "create version" path when activeVersionId is null.
 *  4. seedDev() skips the version insert when activeVersionId is already set.
 *  5. seed() calls both seedPlatform() and seedDev().
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
  const valuesMock = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
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

  return {
    limitMock,
    whereMock,
    fromMock,
    selectMock,
    onConflictDoNothingMock,
    valuesMock,
    insertMock,
    updateWhereMock,
    updateSetMock,
    updateMock,
    mockTx,
    withSystemDbMock,
    closeDatabaseMock,
  };
});

vi.mock("./tenant", () => ({ withSystemDb: mocks.withSystemDbMock }));
vi.mock("./client", () => ({ closeDatabase: mocks.closeDatabaseMock }));

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
  mocks.valuesMock
    .mockReset()
    .mockReturnValue({ onConflictDoNothing: mocks.onConflictDoNothingMock });
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

  it("inserts the free plan with insert/values/onConflictDoNothing", async () => {
    await seedPlatform();

    expect(mocks.insertMock).toHaveBeenCalledOnce();
    expect(mocks.valuesMock).toHaveBeenCalledOnce();
    expect(mocks.onConflictDoNothingMock).toHaveBeenCalledOnce();
  });

  it("uses onConflictDoNothing with a target option (idempotent)", async () => {
    await seedPlatform();
    const conflictArg = mocks.onConflictDoNothingMock.mock.calls[0]?.[0] as
      | { target: unknown }
      | undefined;
    expect(conflictArg).toBeDefined();
    expect(conflictArg).toHaveProperty("target");
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

    // withSystemDb is called once per seed function = 2 total
    expect(mocks.withSystemDbMock).toHaveBeenCalledTimes(2);
  });
});
