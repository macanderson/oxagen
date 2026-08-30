// unscoped-meter.wiring.test.ts — wiring check for recordIfUnscoped.
//
// Despite exercising two real modules together, this is a UNIT test: the
// database client and the RLS flag are mocked and no Postgres is involved. The
// suite that needs a live database lives under `integration/` and runs from
// vitest.integration.config.ts — do not move this there.
//
// tenant.test.ts already asserts withSystemDb calls a MOCKED recordIfUnscoped
// with the right args. That proves the call site exists but not that the
// REAL counter it's wired to actually increments. This file deliberately does
// NOT mock "./unscoped-meter" — it exercises withSystemDb against the real
// unscoped-access counter so the "recordIfUnscoped is dead code, never
// called" defect can never silently regress: if the withSystemDb call site
// were ever removed, __unscopedCountForTests() would stop advancing and this
// test would fail.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async () => undefined),
  transaction: vi.fn(),
  rlsEnforced: vi.fn(() => false),
}));

mocks.transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ execute: mocks.execute }),
);

vi.mock("./client", () => ({
  db: () => ({ transaction: mocks.transaction }),
}));
vi.mock("./tenant-flag", () => ({ rlsEnforced: mocks.rlsEnforced }));

// Deliberately NOT mocking "./unscoped-meter" — this is the point of the test.
import { withSystemDb } from "./tenant";
import { __unscopedCountForTests } from "./unscoped-meter";

beforeEach(() => {
  mocks.execute.mockClear();
  mocks.rlsEnforced.mockReturnValue(false);
});

describe("unscoped-meter wiring (real counter, no mock)", () => {
  it("increments the REAL unscoped counter when withSystemDb runs", async () => {
    const before = __unscopedCountForTests();

    await withSystemDb(async () => "ok");

    expect(__unscopedCountForTests()).toBe(before + 1);
  });

  it("increments once per withSystemDb call — multiple calls advance the counter monotonically", async () => {
    const before = __unscopedCountForTests();

    await withSystemDb(async () => undefined);
    await withSystemDb(async () => undefined);
    await withSystemDb(async () => undefined);

    expect(__unscopedCountForTests()).toBe(before + 3);
  });
});
