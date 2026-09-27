import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STELLA_ARCHIVE_AFTER_DAYS_DEFAULT,
  STELLA_ARCHIVE_AFTER_DAYS_SETTING,
} from "@oxagen/oxagen/steering-repo/workspace";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
}));

vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

const {
  archiveAfterDays,
  archiveCutoff,
  archiveIdleSessions,
  listWorkspacePage,
} = await import("./stella-session-archive");

const NOW = new Date("2026-09-26T04:30:00.000Z");
const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const WS = "0192d4a8-7c1e-7a00-8000-0000000000a2";

/** A drizzle client that records each statement and answers queued rows. */
function proxyDb(answers: unknown[][][] = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (text, params) => {
    statements.push({ sql: text, params });
    return { rows: answers.shift() ?? [] };
  });
  return { db, statements };
}

/** Whether a bound parameter list carries this instant, as a Date or ISO text. */
function carriesInstant(params: unknown[], at: Date): boolean {
  return params.some(
    (p) =>
      (p instanceof Date && p.getTime() === at.getTime()) ||
      p === at.toISOString(),
  );
}

beforeEach(() => {
  mocks.withSystemDb.mockReset();
  mocks.withTenantDb.mockReset();
  mocks.runInTenantScope.mockReset();
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

describe("the Stella session archive window (#4435)", () => {
  it("reads the settings key the steering sync writes", () => {
    expect(STELLA_ARCHIVE_AFTER_DAYS_SETTING).toBe("stellaArchiveAfterDays");
  });

  it("uses the days a workspace publishes", () => {
    expect(archiveAfterDays({ stellaArchiveAfterDays: 30 })).toBe(30);
    expect(archiveAfterDays({ stellaArchiveAfterDays: 1 })).toBe(1);
    expect(archiveAfterDays({ stellaArchiveAfterDays: 365 })).toBe(365);
  });

  it("waits 7 days when a workspace publishes none", () => {
    expect(STELLA_ARCHIVE_AFTER_DAYS_DEFAULT).toBe(7);
    expect(archiveAfterDays({})).toBe(7);
    expect(archiveAfterDays({ runEnrichmentEnabled: true })).toBe(7);
    expect(archiveAfterDays(null)).toBe(7);
    expect(archiveAfterDays(undefined)).toBe(7);
    expect(archiveAfterDays("not a bag")).toBe(7);
  });

  it.each([
    ["zero", 0],
    ["a negative number", -3],
    ["more than a year", 366],
    ["part of a day", 2.5],
    ["a string", "14"],
    ["a boolean", true],
    ["null", null],
    ["not a number", Number.NaN],
  ])("falls back to 7 days for %s", (_name, value) => {
    expect(archiveAfterDays({ stellaArchiveAfterDays: value })).toBe(7);
  });

  it("puts the cutoff that many whole days before now, per workspace", () => {
    expect(archiveCutoff(NOW, 7)).toEqual(new Date("2026-09-19T04:30:00.000Z"));
    expect(archiveCutoff(NOW, 30)).toEqual(
      new Date("2026-08-27T04:30:00.000Z"),
    );
    expect(archiveCutoff(NOW, 1)).toEqual(new Date("2026-09-25T04:30:00.000Z"));
  });
});

describe("listWorkspacePage", () => {
  it("pages workspace ids on the shared plane and reads no settings there", async () => {
    const { db, statements } = proxyDb([[[WS, ORG]]]);
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );
    expect(await listWorkspacePage({ after: null, limit: 200 })).toEqual([
      { id: WS, orgId: ORG },
    ]);
    // The window is tenant data on the organization's plane (ADR-042). The
    // shared plane's copy of the row can be stale or empty for an
    // organization with a dedicated plane.
    expect(statements[0]?.sql).not.toContain('"settings"');
  });
});

describe("archiveIdleSessions", () => {
  it("reads the window on the tenant plane and archives by it", async () => {
    const { db, statements } = proxyDb([
      [[{ [STELLA_ARCHIVE_AFTER_DAYS_SETTING]: 30 }]],
      [["c1"], ["c2"]],
    ]);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );

    const out = await archiveIdleSessions({ id: WS, orgId: ORG }, NOW);

    expect(out).toEqual({ days: 30, archived: 2 });
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS },
      expect.any(Function),
    );
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    const [read, write] = statements;
    expect(read?.sql).toContain('"settings"');
    expect(read?.params).toEqual(expect.arrayContaining([WS, ORG]));
    expect(write?.sql).toMatch(/^update "chat"\."conversations"/);
    expect(carriesInstant(write?.params ?? [], archiveCutoff(NOW, 30))).toBe(
      true,
    );
    expect(carriesInstant(write?.params ?? [], archiveCutoff(NOW, 7))).toBe(
      false,
    );
  });

  it("archives by 7 days when the tenant plane's row holds no window", async () => {
    const { db, statements } = proxyDb([[], []]);
    mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(db),
    );

    const out = await archiveIdleSessions({ id: WS, orgId: ORG }, NOW);

    expect(out).toEqual({ days: 7, archived: 0 });
    expect(carriesInstant(statements[1]?.params ?? [], archiveCutoff(NOW, 7))).toBe(
      true,
    );
  });
});
