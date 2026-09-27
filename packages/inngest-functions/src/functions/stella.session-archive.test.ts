import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspacePage: vi.fn(),
  archiveIdleSessions: vi.fn(),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../lib/stella-session-archive", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../lib/stella-session-archive")>();
  return {
    archiveAfterDays: real.archiveAfterDays,
    archiveCutoff: real.archiveCutoff,
    listWorkspacePage: mocks.listWorkspacePage,
    archiveIdleSessions: mocks.archiveIdleSessions,
  };
});
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
}) => Promise<unknown>;
let handler: Handler | null = null;
let config: {
  id?: string;
  retries?: number;
  concurrency?: { limit: number };
} | null = null;
let trigger: { cron?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, on: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

await import("./stella.session-archive");

const stepNames: string[] = [];
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    stepNames.push(name);
    return fn();
  },
};

const ORG = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const DAY_MS = 24 * 60 * 60 * 1000;

function workspace(id: string, settings: unknown = {}) {
  return { id, orgId: ORG, settings };
}

/** The window each archive call used, in whole days before its `now`. */
function daysOfEachCall(): number[] {
  return mocks.archiveIdleSessions.mock.calls.map(([, cutoff, now]) =>
    Math.round((now.getTime() - cutoff.getTime()) / DAY_MS),
  );
}

describe("stella.session-archive", () => {
  beforeEach(() => {
    mocks.listWorkspacePage.mockReset();
    mocks.archiveIdleSessions.mockReset();
    mocks.warn.mockReset();
    stepNames.length = 0;
  });

  it("runs daily at 04:30 UTC, one run at a time, with three retries", () => {
    expect(trigger).toEqual({ cron: "30 4 * * *" });
    expect(config).toMatchObject({
      id: "stella.session-archive",
      retries: 3,
      concurrency: { limit: 1 },
    });
  });

  it("archives each workspace with its own window and counts what it archived", async () => {
    mocks.listWorkspacePage.mockResolvedValueOnce([
      workspace("wrk_a", { stellaArchiveAfterDays: 30 }),
      workspace("wrk_b"),
      workspace("wrk_c", { stellaArchiveAfterDays: 0 }),
    ]);
    mocks.archiveIdleSessions
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2);
    const out = await handler!({ event: { data: {} }, step });

    expect(mocks.listWorkspacePage).toHaveBeenCalledWith({
      after: null,
      limit: 200,
    });
    // An unset window and one outside 1 to 365 both get the 7-day default.
    expect(daysOfEachCall()).toEqual([30, 7, 7]);
    const ids = mocks.archiveIdleSessions.mock.calls.map(([ws]) => ws.id);
    expect(ids).toEqual(["wrk_a", "wrk_b", "wrk_c"]);
    expect(out).toEqual({ workspaces: 3, archived: 6, failed: 0 });
  });

  it("pages through the workspaces, one step per page", async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      workspace(`wrk_${String(i).padStart(3, "0")}`),
    );
    mocks.listWorkspacePage
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([workspace("wrk_last")]);
    mocks.archiveIdleSessions.mockResolvedValue(1);
    const out = await handler!({ event: { data: {} }, step });

    expect(stepNames).toEqual([
      "archive-sessions-page-0",
      "archive-sessions-page-1",
    ]);
    expect(mocks.listWorkspacePage).toHaveBeenLastCalledWith({
      after: "wrk_199",
      limit: 200,
    });
    expect(out).toEqual({ workspaces: 201, archived: 201, failed: 0 });
  });

  it("logs a workspace that fails and carries on with the rest", async () => {
    mocks.listWorkspacePage.mockResolvedValueOnce([
      workspace("wrk_broken"),
      workspace("wrk_ok"),
    ]);
    mocks.archiveIdleSessions
      .mockRejectedValueOnce(new Error("lock timeout"))
      .mockResolvedValueOnce(3);
    const out = await handler!({ event: { data: {} }, step });

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ workspaces: 2, archived: 3, failed: 1 });
  });
});
