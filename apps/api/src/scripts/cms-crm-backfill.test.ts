/**
 * Unit tests for the CRM backfill script: argument parsing, the report it
 * prints and the exit code. The sync itself is mocked; crm-sync.test.ts
 * covers it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isCrmSyncConfigured: vi.fn(),
  syncPendingLeads: vi.fn(),
}));

vi.mock("../lib/cms/crm-sync", () => ({
  isCrmSyncConfigured: mocks.isCrmSyncConfigured,
  syncPendingLeads: mocks.syncPendingLeads,
}));

const originalArgv = process.argv;
const originalDbUrl = process.env.DATABASE_URL;

async function run(argv: string[] = []) {
  process.argv = ["node", "cms-crm-backfill.ts", ...argv];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.resetModules();
  await import("./cms-crm-backfill");
  // main() is a floating promise; let it settle.
  await new Promise((r) => setTimeout(r, 0));
  return { log, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  process.env.DATABASE_URL = "postgres://oxagen:oxagen@localhost:5433/oxagen";
  mocks.isCrmSyncConfigured.mockReturnValue(true);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDbUrl;
  vi.restoreAllMocks();
});

describe("cms:crm-backfill", () => {
  it("echoes the database host, syncs with the default limit and reports", async () => {
    mocks.syncPendingLeads.mockResolvedValue([
      { status: "synced", leadId: "a", recordId: "r" },
      { status: "skipped", leadId: "b", reason: "not_found" },
    ]);
    const { log } = await run();
    expect(mocks.syncPendingLeads).toHaveBeenCalledWith({ limit: 500 });
    expect(log).toHaveBeenCalledWith(
      "cms:crm-backfill → database localhost:5433",
    );
    expect(log).toHaveBeenCalledWith(
      "2 pending · 1 synced · 0 failed · 1 skipped",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("honours --limit and exits non-zero when a lead failed", async () => {
    mocks.syncPendingLeads.mockResolvedValue([
      { status: "failed", leadId: "a", error: "Attio 400" },
    ]);
    const { log } = await run(["--limit", "25"]);
    expect(mocks.syncPendingLeads).toHaveBeenCalledWith({ limit: 25 });
    expect(log).toHaveBeenCalledWith("  a: Attio 400");
    expect(process.exitCode).toBe(1);
  });

  it("refuses a bad --limit", async () => {
    const { error } = await run(["--limit", "zero"]);
    expect(mocks.syncPendingLeads).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "--limit needs a positive integer, got zero",
    );
    expect(process.exitCode).toBe(1);
  });

  it("refuses to run without ATTIO_API_KEY", async () => {
    mocks.isCrmSyncConfigured.mockReturnValue(false);
    const { error } = await run();
    expect(mocks.syncPendingLeads).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "ATTIO_API_KEY is not set; nothing to sync to",
    );
    expect(process.exitCode).toBe(1);
  });

  it("says so when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    mocks.syncPendingLeads.mockResolvedValue([]);
    const { log } = await run();
    expect(log).toHaveBeenCalledWith(
      "cms:crm-backfill → database (DATABASE_URL unset)",
    );
  });
});
