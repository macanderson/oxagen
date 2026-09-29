// The headless steering backfill (#4683). The job reads pages of workspaces
// that have no steering head and sends each one the provision event. These
// tests replace the read with a fake and assert what the job sends, how it
// pages, and when it stops.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
  list: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
vi.mock("../lib/steering-repo-backfill", () => ({
  listHeadlessWorkspaces: mocks.list,
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import type { HeadlessWorkspace } from "../lib/steering-repo-backfill";
import {
  BACKFILL_MAX_PAGES,
  BACKFILL_PAGE_SIZE,
  QUEUED_GRACE_MS,
  steeringRepoBackfill,
} from "./steering-repo.backfill";

const ORG_ID = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const USER_ID = "0192d4a8-7c1e-7a00-8000-0000000005e1";

type FakeStep = {
  names: string[];
  sent: { label: string; events: unknown }[];
  run: (name: string, fn: () => unknown) => Promise<unknown>;
  sendEvent: (label: string, events: unknown) => Promise<void>;
};

type Handler = (ctx: { step: FakeStep }) => Promise<unknown>;

const backfill = steeringRepoBackfill as unknown as Handler;

/**
 * A step that records each name and each send, then runs the body. A name in
 * `memo` returns the stored output without running the body, as Inngest does
 * on a replay.
 */
function fakeStep(memo: ReadonlyMap<string, unknown> = new Map()): FakeStep {
  const names: string[] = [];
  const sent: { label: string; events: unknown }[] = [];
  return {
    names,
    sent,
    run: async (name, fn) => {
      names.push(name);
      return memo.has(name) ? memo.get(name) : fn();
    },
    sendEvent: async (label, events) => {
      names.push(label);
      sent.push({ label, events });
    },
  };
}

/** A workspace id that sorts by `n`, as the keyset read expects. */
const workspaceId = (n: number) =>
  `0192d4a8-7c1e-7a00-8000-${n.toString(16).padStart(12, "0")}`;

function workspace(
  n: number,
  actorUserId: string | null = USER_ID,
): HeadlessWorkspace {
  return { orgId: ORG_ID, workspaceId: workspaceId(n), actorUserId };
}

/** `count` workspaces numbered from `from`. */
function rows(from: number, count: number): HeadlessWorkspace[] {
  return Array.from({ length: count }, (_, i) => workspace(from + i));
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.warn.mockReset();
});

describe("steering repo headless backfill", () => {
  it("runs every 15 minutes, one run at a time", () => {
    const config = mocks.configs.find(
      (c) =>
        (c.options as { id: string }).id === "steering-repo/headless-backfill",
    );
    expect(config).toBeDefined();
    expect(config!.trigger).toEqual({ cron: "*/15 * * * *" });
    expect(config!.options).toMatchObject({ concurrency: { limit: 1 } });
  });

  it("sends nothing when every workspace has a steering head", async () => {
    mocks.list.mockResolvedValueOnce([]);
    const step = fakeStep();

    await expect(backfill({ step })).resolves.toEqual({
      requested: 0,
      skipped: 0,
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({
      after: null,
      queuedBefore: expect.any(Date),
      limit: BACKFILL_PAGE_SIZE,
    });
    expect(step.sent).toEqual([]);
  });

  it("counts a queued workspace only after the grace period", async () => {
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    vi.useFakeTimers({ now });
    try {
      mocks.list.mockResolvedValueOnce([]);
      await backfill({ step: fakeStep() });
    } finally {
      vi.useRealTimers();
    }
    const read = mocks.list.mock.calls[0]?.[0] as { queuedBefore: Date };
    expect(read.queuedBefore.getTime()).toBe(now - QUEUED_GRACE_MS);
  });

  it("sends the provision event with an id that names the workspace", async () => {
    mocks.list.mockResolvedValueOnce([workspace(1), workspace(2)]);
    const step = fakeStep();

    await expect(backfill({ step })).resolves.toEqual({
      requested: 2,
      skipped: 0,
    });

    expect(step.sent).toEqual([
      {
        label: "request-provisioning-0",
        events: [1, 2].map((n) => ({
          name: "steering-repo/provision.requested",
          id: `steering-repo-backfill:${workspaceId(n)}`,
          data: {
            orgId: ORG_ID,
            workspaceId: workspaceId(n),
            actorUserId: USER_ID,
          },
        })),
      },
    ]);
  });

  it("reads the next page after the last id of a full page", async () => {
    const first = rows(1, BACKFILL_PAGE_SIZE);
    mocks.list
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(rows(BACKFILL_PAGE_SIZE + 1, 3));
    const step = fakeStep();

    await expect(backfill({ step })).resolves.toEqual({
      requested: BACKFILL_PAGE_SIZE + 3,
      skipped: 0,
    });

    expect(mocks.list.mock.calls).toEqual([
      [
        {
          after: null,
          queuedBefore: expect.any(Date),
          limit: BACKFILL_PAGE_SIZE,
        },
      ],
      [
        {
          after: first.at(-1)!.workspaceId,
          queuedBefore: expect.any(Date),
          limit: BACKFILL_PAGE_SIZE,
        },
      ],
    ]);
    expect(step.sent.map((s) => s.label)).toEqual([
      "request-provisioning-0",
      "request-provisioning-1",
    ]);
    expect(new Set(step.names).size).toBe(step.names.length);
  });

  it("skips a workspace with no creator and logs its id", async () => {
    mocks.list.mockResolvedValueOnce([workspace(1), workspace(2, null)]);
    const step = fakeStep();

    await expect(backfill({ step })).resolves.toEqual({
      requested: 1,
      skipped: 1,
    });

    const events = step.sent[0]!.events as { data: { workspaceId: string } }[];
    expect(events.map((e) => e.data.workspaceId)).toEqual([workspaceId(1)]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { workspaceIds: [workspaceId(2)] },
      expect.stringContaining("no creator"),
    );
  });

  it("sends no event for a page where no workspace has a creator (negative)", async () => {
    mocks.list.mockResolvedValueOnce([workspace(1, null)]);
    const step = fakeStep();

    await expect(backfill({ step })).resolves.toEqual({
      requested: 0,
      skipped: 1,
    });
    expect(step.sent).toEqual([]);
  });

  it(`stops after ${BACKFILL_MAX_PAGES} pages and leaves the rest to the next run`, async () => {
    let next = 1;
    mocks.list.mockImplementation(async () => {
      const page = rows(next, BACKFILL_PAGE_SIZE);
      next += BACKFILL_PAGE_SIZE;
      return page;
    });
    const step = fakeStep();

    await expect(backfill({ step })).resolves.toEqual({
      requested: BACKFILL_MAX_PAGES * BACKFILL_PAGE_SIZE,
      skipped: 0,
    });
    expect(mocks.list).toHaveBeenCalledTimes(BACKFILL_MAX_PAGES);
    expect(step.sent).toHaveLength(BACKFILL_MAX_PAGES);
  });

  it("pages from the stored rows on a replay, not a new read", async () => {
    // Inngest replays the handler after each step. The first page comes back
    // from the step memo, so the cursor for the second read has to come from
    // those rows.
    const stored = rows(1, BACKFILL_PAGE_SIZE);
    mocks.list.mockResolvedValueOnce([]);
    const step = fakeStep(new Map([["list-headless-workspaces-0", stored]]));

    await backfill({ step });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({
      after: stored.at(-1)!.workspaceId,
      queuedBefore: expect.any(Date),
      limit: BACKFILL_PAGE_SIZE,
    });
  });
});
