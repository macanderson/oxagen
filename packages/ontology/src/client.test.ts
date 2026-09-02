import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// We stub neo4j-driver at the module boundary so the singleton test can verify
// the lazy-init contract without a real AuraDB connection.
const mocks = vi.hoisted(() => ({
  closeFn: vi.fn(async () => undefined),
  sessionFn: vi.fn(),
  runFn: vi.fn(async () => undefined),
  neo4jDriver: vi.fn(),
  neo4jAuthBasic: vi.fn(() => ({
    scheme: "basic",
    principal: "neo4j",
    credentials: "test",
  })),
}));

// Session mock — close() is observable
const sessionInstance = {
  close: vi.fn(async () => undefined),
  run: mocks.runFn,
};
mocks.sessionFn.mockReturnValue(sessionInstance);

// Driver mock — .session() delegates to sessionFn; .close() to closeFn
const driverInstance = {
  session: mocks.sessionFn,
  close: mocks.closeFn,
};
mocks.neo4jDriver.mockReturnValue(driverInstance);

vi.mock("neo4j-driver", () => ({
  default: {
    driver: mocks.neo4jDriver,
    auth: { basic: mocks.neo4jAuthBasic },
  },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: (keys: string[]) => {
    const record: Record<string, string> = {};
    for (const k of keys) {
      if (k === "NEO4J_URI") record[k] = "bolt://localhost:7687";
      else if (k === "NEO4J_USERNAME") record[k] = "neo4j";
      else if (k === "NEO4J_PASSWORD") record[k] = "test-password";
      else if (k === "NEO4J_DATABASE") record[k] = "neo4j";
    }
    return record;
  },
}));

// Import AFTER mocks so the module under test picks up stubbed deps.
import { driver, session, closeDriver } from "./client";

// Helper: reset all mock call counts and ensure the singleton is closed
async function resetSingleton() {
  await closeDriver();
  mocks.neo4jDriver.mockClear();
  mocks.neo4jAuthBasic.mockClear();
  mocks.closeFn.mockClear();
  mocks.sessionFn.mockClear();
  // Restore return values after mockClear
  mocks.neo4jDriver.mockReturnValue(driverInstance);
  mocks.neo4jAuthBasic.mockReturnValue({
    scheme: "basic",
    principal: "neo4j",
    credentials: "test",
  });
  mocks.sessionFn.mockReturnValue(sessionInstance);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("driver() singleton (@oxagen/ontology)", () => {
  beforeEach(resetSingleton);
  afterEach(resetSingleton);

  it("initialises the driver with URI and basic auth on first call", () => {
    const d = driver();
    expect(mocks.neo4jDriver).toHaveBeenCalledTimes(1);
    expect(mocks.neo4jDriver).toHaveBeenCalledWith(
      "bolt://localhost:7687",
      expect.objectContaining({ scheme: "basic" }),
    );
    expect(d).toBe(driverInstance);
  });

  it("returns the same driver instance on repeated calls (singleton)", () => {
    const d1 = driver();
    // A second call must not re-run the constructor
    const countAfterFirst = mocks.neo4jDriver.mock.calls.length;
    const d2 = driver();
    const countAfterSecond = mocks.neo4jDriver.mock.calls.length;
    expect(d1).toBe(d2);
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

describe("session() factory (@oxagen/ontology)", () => {
  beforeEach(resetSingleton);
  afterEach(resetSingleton);

  it("opens a session on the configured database", () => {
    const s = session();
    expect(mocks.sessionFn).toHaveBeenCalledTimes(1);
    expect(mocks.sessionFn).toHaveBeenCalledWith({ database: "neo4j" });
    expect(s).toBe(sessionInstance);
  });

  it("returns a fresh session object each call (no session caching)", () => {
    session();
    session();
    // The factory must invoke driver().session() each time — no memoisation
    expect(mocks.sessionFn).toHaveBeenCalledTimes(2);
  });
});

describe("closeDriver() (@oxagen/ontology)", () => {
  beforeEach(resetSingleton);

  it("calls driver.close() once when a driver is active", async () => {
    driver(); // initialise the singleton
    await closeDriver();
    expect(mocks.closeFn).toHaveBeenCalledTimes(1);
  });

  it("nulls the singleton so the next driver() call re-creates it", async () => {
    driver();
    await closeDriver();
    mocks.neo4jDriver.mockClear();
    driver(); // must trigger a new instantiation
    expect(mocks.neo4jDriver).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no driver is active (does not call close)", async () => {
    // No driver() call before closeDriver
    await closeDriver();
    expect(mocks.closeFn).not.toHaveBeenCalled();
  });

  it("second closeDriver() call after first is also a no-op", async () => {
    driver();
    await closeDriver(); // first — closes
    mocks.closeFn.mockClear();
    await closeDriver(); // second — noop
    expect(mocks.closeFn).not.toHaveBeenCalled();
  });
});
