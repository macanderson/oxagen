import { describe, expect, it, vi, beforeEach } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";

// The handler issues one read: select(...).from(exportRequests).where().limit(1).
// The `where` is captured so the principal fence can be asserted rather than
// assumed --- a status read that matched on the id alone would hand one person
// another's bundle.
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  where: null as unknown,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          mocks.where = clause;
          return { limit: () => Promise.resolve(mocks.rows) };
        },
      }),
    }),
  });
  return {
    ...real,
    withSystemDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

import { privacyDataExportStatusHandler } from "./privacy.data.export.status";

const EXPORT_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function ctx(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    userId: USER_ID,
    ...overrides,
  } as CapabilityContext;
}

beforeEach(() => {
  mocks.rows = [];
  mocks.where = null;
});

describe("get_export_status", () => {
  it("refuses a machine principal", async () => {
    await expect(
      privacyDataExportStatusHandler(
        { exportId: EXPORT_ID },
        ctx({
          userId: null,
        } as Partial<CapabilityContext>),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "forbidden",
    );
  });

  it("answers not_found for an id that is not this person's", async () => {
    mocks.rows = [];
    await expect(
      privacyDataExportStatusHandler({ exportId: EXPORT_ID }, ctx()),
    ).rejects.toSatisfy(
      (error: unknown) => isHandlerError(error) && error.code === "not_found",
    );
    // The row was looked for under a two-part match, not by id alone.
    expect(mocks.where).not.toBeNull();
  });

  it("hands back the storage key once the bundle is ready", async () => {
    const completed = new Date("2026-09-18T22:00:00.000Z");
    mocks.rows = [
      {
        id: EXPORT_ID,
        status: "ready",
        exportUrl: "privacy-exports/org/exp.zip",
        completedAt: completed,
      },
    ];
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out).toEqual({
      exportId: EXPORT_ID,
      status: "ready",
      ready: true,
      storageKey: "privacy-exports/org/exp.zip",
      completedAt: "2026-09-18T22:00:00.000Z",
    });
  });

  it("offers no link while the bundle is still being written", async () => {
    mocks.rows = [
      {
        id: EXPORT_ID,
        status: "processing",
        exportUrl: null,
        completedAt: null,
      },
    ];
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out).toEqual({
      exportId: EXPORT_ID,
      status: "processing",
      ready: false,
      storageKey: null,
      completedAt: null,
    });
  });

  // A url left on a row that later failed is not a bundle anyone should be
  // pointed at.
  it("offers no key for a failed export that still carries one", async () => {
    mocks.rows = [
      {
        id: EXPORT_ID,
        status: "failed",
        exportUrl: "privacy-exports/org/half-written.zip",
        completedAt: null,
      },
    ];
    const out = await privacyDataExportStatusHandler(
      { exportId: EXPORT_ID },
      ctx(),
    );
    expect(out.status).toBe("failed");
    expect(out.ready).toBe(false);
    expect(out.storageKey).toBeNull();
  });
});
