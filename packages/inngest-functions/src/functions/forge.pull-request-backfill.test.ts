// The scheduled forge backfill (ADR-292): each store is read a page at a time
// from a start point that moves each 15-minute slot, wrapping round to the
// lowest id, through the runner `@oxagen/handlers` installs. These tests
// install a fake runner over a fake store and assert the pages it is asked
// for, the order it reads rows in, and the events the function sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
  warn: vi.fn(),
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import {
  type ForgeBackfillEvent,
  type ForgeBackfillPage,
  type ForgeBackfillRequest,
  type ForgeBackfillRunner,
  type ForgeBackfillSource,
  setForgeBackfillRunner,
} from "../lib/forge-pull-request-backfill-runner";
import {
  backfillStart,
  FORGE_BACKFILL_MAX_PAGES,
  FORGE_BACKFILL_PAGE_SIZE,
  FORGE_BACKFILL_SLOT_MS,
  forgePullRequestBackfill,
} from "./forge.pull-request-backfill";

type Handler = (args: {
  step: {
    run: (id: string, fn: () => unknown) => unknown;
    sendEvent: (id: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
const handler = forgePullRequestBackfill as unknown as Handler;

const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const NOW = new Date("2026-10-03T12:07:00Z");
const EVENT: ForgeBackfillEvent = {
  id: `forge-backfill:${WS}:github:acme/api#42:tse_4q8r1t6v3x5z0b2d7h2k9m`,
  data: {
    orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
    workspaceId: WS,
    provider: "github",
    repository: "acme/api",
    number: 42,
    pullKey: `${WS}:github:acme/api#42`,
    link: { rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1", opened: false },
  },
};

/** The uuid whose last digits spell `n`, so ids sort as their numbers do. */
const idOf = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

/**
 * A runner over an in-memory store of `count` rows per source. Each page
 * answers the rows the request's bounds admit, in id order, and the runner
 * records every row it handed out, so a test can read the order of the pass.
 */
function store(
  counts: Partial<Record<ForgeBackfillSource, number>>,
  eventFor: (id: string) => ForgeBackfillEvent[] = () => [],
): ForgeBackfillRunner & { visited: string[]; requests: ForgeBackfillRequest[] } {
  const lists = {
    run_pull_requests: Array.from({ length: counts.run_pull_requests ?? 0 }, (_, i) => idOf(i + 1)),
    pr_linked: Array.from({ length: counts.pr_linked ?? 0 }, (_, i) => idOf(i + 1)),
  };
  const ids = (source: ForgeBackfillSource) => lists[source];
  const visited: string[] = [];
  const requests: ForgeBackfillRequest[] = [];
  return {
    visited,
    requests,
    range: (source) => {
      const all = ids(source);
      const first = all[0];
      const last = all.at(-1);
      return Promise.resolve(
        first === undefined || last === undefined ? null : { first, last },
      );
    },
    page: (request): Promise<ForgeBackfillPage> => {
      requests.push(request);
      const rows = ids(request.source)
        .filter(
          (id) =>
            (request.after === null || id > request.after) &&
            (request.until === null || id <= request.until),
        )
        .slice(0, request.limit);
      visited.push(...rows);
      return Promise.resolve({
        events: rows.flatMap(eventFor),
        read: rows.length,
        last: rows.at(-1) ?? null,
      });
    },
  };
}

const steps: string[] = [];
const sent: { id: string; events: unknown }[] = [];
const step = {
  run: (id: string, fn: () => unknown) => {
    steps.push(id);
    return fn();
  },
  sendEvent: (id: string, events: unknown) => {
    steps.push(id);
    sent.push({ id, events });
    return Promise.resolve();
  },
};

beforeEach(() => {
  steps.length = 0;
  sent.length = 0;
  mocks.warn.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("backfillStart", () => {
  const range = { first: idOf(1), last: idOf(1_000_000) };

  it("picks a point inside the range, the same one all slot long", () => {
    const start = backfillStart(range, NOW);
    expect(start >= range.first && start <= range.last).toBe(true);
    const slotStart = new Date(
      Math.floor(NOW.getTime() / FORGE_BACKFILL_SLOT_MS) * FORGE_BACKFILL_SLOT_MS,
    );
    expect(backfillStart(range, slotStart)).toBe(start);
    expect(start).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("moves to another point in the next slot", () => {
    const next = new Date(NOW.getTime() + FORGE_BACKFILL_SLOT_MS);
    expect(backfillStart(range, next)).not.toBe(backfillStart(range, NOW));
  });

  it("spreads its starts across the range over a day of slots", () => {
    const starts = Array.from({ length: 96 }, (_, i) =>
      backfillStart(range, new Date(NOW.getTime() + i * FORGE_BACKFILL_SLOT_MS)),
    );
    expect(starts.some((s) => s < idOf(250_000))).toBe(true);
    expect(starts.some((s) => s > idOf(750_000))).toBe(true);
  });

  it("answers the one id of a store that holds one row (negative)", () => {
    expect(backfillStart({ first: idOf(7), last: idOf(7) }, NOW)).toBe(idOf(7));
  });
});

describe("forge.pull-request-backfill", () => {
  it("runs every 15 minutes, one run at a time", () => {
    expect(mocks.configs[0]).toEqual({
      options: {
        id: "forge/pull-request-backfill",
        retries: 1,
        concurrency: { limit: 1 },
      },
      trigger: { cron: "*/15 * * * *" },
    });
  });

  it("reads the rows after the start, then wraps round to the rows before it, each once", async () => {
    const fake = store({ run_pull_requests: 1_200 });
    setForgeBackfillRunner(fake);
    const start = backfillStart({ first: idOf(1), last: idOf(1_200) }, NOW);
    await expect(handler({ step })).resolves.toEqual({
      read: 1_200,
      requested: 0,
      bounded: [],
    });
    const after = fake.visited.filter((id) => id > start);
    const before = fake.visited.filter((id) => id <= start);
    expect(after.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(0);
    // Every row after the start comes before every row up to it.
    expect(fake.visited).toEqual([...after, ...before]);
    expect(new Set(fake.visited).size).toBe(1_200);
    expect(fake.requests[0]).toEqual({
      source: "run_pull_requests",
      after: start,
      until: null,
      limit: FORGE_BACKFILL_PAGE_SIZE,
    });
    expect(fake.requests.find((request) => request.until !== null)).toEqual({
      source: "run_pull_requests",
      after: null,
      until: start,
      limit: FORGE_BACKFILL_PAGE_SIZE,
    });
  });

  it("sends each page's events as observed events, in a step after the read", async () => {
    const fake = store({ run_pull_requests: 3 }, (id) => (id === idOf(2) ? [EVENT] : []));
    setForgeBackfillRunner(fake);
    await expect(handler({ step })).resolves.toMatchObject({ read: 3, requested: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toEqual([
      { name: "forge/pull-request.observed", id: EVENT.id, data: EVENT.data },
    ]);
    expect(steps[0]).toBe("start-run_pull_requests");
    expect(steps).toContain("start-pr_linked");
  });

  it("reads nothing from a store that holds no row", async () => {
    const fake = store({});
    setForgeBackfillRunner(fake);
    await expect(handler({ step })).resolves.toEqual({ read: 0, requested: 0, bounded: [] });
    expect(fake.requests).toEqual([]);
    expect(steps).toEqual(["start-run_pull_requests", "start-pr_linked"]);
  });

  it("stops at the page bound across both legs and says so (negative)", async () => {
    const rows = FORGE_BACKFILL_PAGE_SIZE * (FORGE_BACKFILL_MAX_PAGES + 5);
    const fake = store({ pr_linked: rows });
    setForgeBackfillRunner(fake);
    const out = (await handler({ step })) as { read: number; bounded: string[] };
    expect(out.bounded).toEqual(["pr_linked"]);
    expect(out.read).toBeLessThanOrEqual(FORGE_BACKFILL_PAGE_SIZE * FORGE_BACKFILL_MAX_PAGES);
    expect(fake.requests).toHaveLength(FORGE_BACKFILL_MAX_PAGES);
    expect(new Set(fake.visited).size).toBe(fake.visited.length);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("reaches rows past the bound on a later run, from another start", async () => {
    const rows = FORGE_BACKFILL_PAGE_SIZE * (FORGE_BACKFILL_MAX_PAGES + 5);
    const fake = store({ pr_linked: rows });
    setForgeBackfillRunner(fake);
    for (let slot = 0; slot < 96; slot++) {
      vi.setSystemTime(new Date(NOW.getTime() + slot * FORGE_BACKFILL_SLOT_MS));
      await handler({ step });
    }
    // One run reads at most the bound; a day of runs reads every row.
    expect(new Set(fake.visited).size).toBe(rows);
  });

  it("lets a runner failure reach Inngest, which retries (negative)", async () => {
    setForgeBackfillRunner({
      range: () => Promise.reject(new Error("postgres is down")),
      page: () => Promise.reject(new Error("unreachable")),
    });
    await expect(handler({ step })).rejects.toThrow("postgres is down");
    expect(sent).toEqual([]);
  });
});
