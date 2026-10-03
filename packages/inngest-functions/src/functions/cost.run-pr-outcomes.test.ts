// cost.run-pr-outcomes (#4491): the hourly refresh hands each workspace to
// the runner `@oxagen/handlers` installs, and the delivery function folds
// GitHub pull request and commit deliveries into the table.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspacesForOutcomes: vi.fn(),
  applyOutcomeDelivery: vi.fn(),
  pruneRevertEvidence: vi.fn(),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  listWorkspacesForOutcomes: mocks.listWorkspacesForOutcomes,
  applyOutcomeDelivery: mocks.applyOutcomeDelivery,
  pruneRevertEvidence: mocks.pruneRevertEvidence,
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  event?: { data: unknown };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;
const registered = new Map<
  string,
  { config: Record<string, unknown>; trigger: unknown; handler: Handler }
>();
mocks.createFunction.mockImplementation(
  (config: { id: string }, trigger: unknown, handler: Handler) => {
    registered.set(config.id, { config, trigger, handler });
    return [{}];
  },
);

await import("./cost.run-pr-outcomes");
const { setRunPrOutcomesRunner } = await import("../lib/run-pr-outcomes-runner");

const steps: string[] = [];
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    steps.push(name);
    return fn();
  },
};
const WS_A = { orgId: "org-1", workspaceId: "ws-a" };
const WS_B = { orgId: "org-1", workspaceId: "ws-b" };
const SHA = "1234567890abcdef1234567890abcdef12345678";

const hourly = () => {
  const found = registered.get("cost.run-pr-outcomes-hourly");
  if (!found) throw new Error("hourly function not registered");
  return found;
};
const delivery = () => {
  const found = registered.get("cost.run-pr-outcomes-delivery");
  if (!found) throw new Error("delivery function not registered");
  return found;
};

beforeEach(() => {
  steps.length = 0;
  mocks.listWorkspacesForOutcomes.mockReset();
  mocks.applyOutcomeDelivery.mockReset();
  mocks.pruneRevertEvidence.mockReset();
  mocks.pruneRevertEvidence.mockResolvedValue(0);
  mocks.warn.mockReset();
});

describe("cost.run-pr-outcomes-hourly", () => {
  it("runs hourly at 15 past", () => {
    expect(hourly().config).toMatchObject({ id: "cost.run-pr-outcomes-hourly" });
    expect(hourly().trigger).toEqual({ cron: "15 * * * *" });
  });

  it("runs one pass per workspace, each in its own step", async () => {
    mocks.listWorkspacesForOutcomes.mockResolvedValue([WS_A, WS_B]);
    const runner = vi.fn(() =>
      Promise.resolve({ runs: 3, forgeReads: 2, deferred: 0, rows: 4, reverted: 1 }),
    );
    setRunPrOutcomesRunner(runner);
    const out = await hourly().handler({ step });
    expect(runner.mock.calls).toEqual([[WS_A], [WS_B]]);
    expect(steps).toEqual([
      "list-workspaces",
      "outcomes-ws-a",
      "outcomes-ws-b",
      "prune-reverts",
    ]);
    expect(out).toEqual({ workspaces: 2, passed: 2, rows: 8, pruned: 0 });
  });

  it("deletes the kept reverts Oxagen saw more than 31 days ago, after the passes", async () => {
    mocks.listWorkspacesForOutcomes.mockResolvedValue([]);
    mocks.pruneRevertEvidence.mockResolvedValue(3);
    const day = 24 * 60 * 60 * 1000;
    const start = Date.now();
    const out = await hourly().handler({ step });
    const end = Date.now();
    expect(steps).toEqual(["list-workspaces", "prune-reverts"]);
    expect(mocks.pruneRevertEvidence).toHaveBeenCalledTimes(1);
    const [before] = mocks.pruneRevertEvidence.mock.calls[0] as [Date];
    expect(before.getTime()).toBeGreaterThanOrEqual(start - 31 * day);
    expect(before.getTime()).toBeLessThanOrEqual(end - 31 * day);
    expect(out).toEqual({ workspaces: 0, passed: 0, rows: 0, pruned: 3 });
  });

  it("goes on past a workspace whose pass fails", async () => {
    mocks.listWorkspacesForOutcomes.mockResolvedValue([WS_A, WS_B]);
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub is down"))
      .mockResolvedValueOnce({ runs: 1, forgeReads: 1, deferred: 0, rows: 1, reverted: 0 });
    setRunPrOutcomesRunner(runner);
    const out = await hourly().handler({ step });
    expect(out).toEqual({ workspaces: 2, passed: 1, rows: 1, pruned: 0 });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});

describe("cost.run-pr-outcomes-delivery", () => {
  const event = (data: Record<string, unknown>) => ({
    data: {
      connectionId: "conn-1",
      orgId: "org-1",
      workspaceId: "ws-a",
      connectorType: "github",
      idempotencyKey: "k",
      receivedAt: "2026-09-27T12:00:00Z",
      ...data,
    },
  });
  const merged = {
    number: 9,
    state: "closed",
    merged: true,
    merged_at: "2026-09-27T11:00:00Z",
    closed_at: "2026-09-27T11:00:00Z",
    body: "Reverts acme/app#5",
    updated_at: "2026-09-27T11:00:01Z",
    html_url: "https://github.com/acme/app/pull/9",
    base: { ref: "main", repo: { full_name: "acme/app" } },
    head: { ref: "revert-5", sha: SHA },
  };

  it("triggers on each ingested record, bounded per org", () => {
    expect(delivery().config).toMatchObject({
      concurrency: [{ limit: 2 }, { limit: 5, key: "event.data.orgId" }],
    });
    expect(delivery().trigger).toEqual({ event: "ingestion/entity.received" });
  });

  it("applies a GitHub pull request delivery in one step", async () => {
    mocks.applyOutcomeDelivery.mockResolvedValue({ rows: 1, reverted: 1 });
    const out = await delivery().handler({
      event: event({ sourceRecordType: "pull_request", payload: merged }),
      step,
    });
    expect(out).toEqual({ applied: true, rows: 1, reverted: 1 });
    expect(steps).toEqual(["apply-delivery"]);
    expect(mocks.applyOutcomeDelivery).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-a" },
      expect.objectContaining({
        kind: "pull_request",
        repository: "acme/app",
        number: 9,
        state: "merged",
      }),
    );
  });

  it("applies a pushed commit that reverts a commit", async () => {
    mocks.applyOutcomeDelivery.mockResolvedValue({ rows: 0, reverted: 1 });
    await delivery().handler({
      event: event({
        sourceRecordType: "commit",
        payload: {
          sha: "b".repeat(40),
          html_url: `https://github.com/acme/app/commit/${"b".repeat(40)}`,
          git_branch: "main",
          commit: { message: `Revert "x"\n\nThis reverts commit ${SHA}.` },
        },
      }),
      step,
    });
    expect(mocks.applyOutcomeDelivery).toHaveBeenCalledTimes(1);
  });

  it("applies a revert commit the poll read, on the default branch it listed (#5263)", async () => {
    // The first poll after a connection marks its records backfill. A revert
    // is a fact whenever Oxagen reads it, so the flag stops no revert.
    mocks.applyOutcomeDelivery.mockResolvedValue({ rows: 0, reverted: 1 });
    await delivery().handler({
      event: event({
        sourceRecordType: "commit",
        backfill: true,
        payload: {
          sha: "b".repeat(40),
          html_url: `https://github.com/acme/app/commit/${"b".repeat(40)}`,
          commit: {
            message: `Revert "x"\n\nThis reverts commit ${SHA}.`,
            author: { date: "2026-09-27T11:30:00Z" },
            committer: { date: "2026-09-27T11:30:00Z" },
          },
          git_branch: "trunk",
        },
      }),
      step,
    });
    expect(mocks.applyOutcomeDelivery).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-a" },
      expect.objectContaining({ kind: "commit", branch: "trunk" }),
    );
  });

  it("opens no step for a commit that reverts nothing, another connector, or another record", async () => {
    const commit = {
      sha: "b".repeat(40),
      html_url: `https://github.com/acme/app/commit/${"b".repeat(40)}`,
      commit: { message: "Add x" },
    };
    const skipped = [
      event({ sourceRecordType: "commit", payload: commit }),
      event({ connectorType: "slack", sourceRecordType: "pull_request", payload: merged }),
      event({ sourceRecordType: "issue", payload: merged }),
      event({ orgId: undefined, sourceRecordType: "pull_request", payload: merged }),
    ];
    for (const e of skipped)
      await expect(delivery().handler({ event: e, step })).resolves.toEqual({
        applied: false,
      });
    expect(steps).toEqual([]);
    expect(mocks.applyOutcomeDelivery).not.toHaveBeenCalled();
  });
});
