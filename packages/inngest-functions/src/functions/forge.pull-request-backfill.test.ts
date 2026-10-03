// The scheduled forge backfill (ADR-292): each store is read a page at a time
// through the runner `@oxagen/handlers` installs, and each page's events are
// sent in a step of their own. These tests install a fake runner and assert
// the pages it is asked for and the events the function sends.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  setForgeBackfillRunner,
} from "../lib/forge-pull-request-backfill-runner";
import {
  FORGE_BACKFILL_MAX_PAGES,
  FORGE_BACKFILL_PAGE_SIZE,
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

const empty: ForgeBackfillPage = { events: [], read: 0, last: null };

beforeEach(() => {
  steps.length = 0;
  sent.length = 0;
  mocks.warn.mockReset();
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

  it("sends each page's events as observed events, in a step after the read", async () => {
    const runner = vi.fn((request: ForgeBackfillRequest) =>
      Promise.resolve(
        request.source === "run_pull_requests"
          ? { events: [EVENT], read: 3, last: "row-3" }
          : empty,
      ),
    );
    setForgeBackfillRunner(runner);
    await expect(handler({ step })).resolves.toEqual({
      read: 3,
      requested: 1,
      bounded: [],
    });
    expect(runner.mock.calls).toEqual([
      [{ source: "run_pull_requests", after: null, limit: FORGE_BACKFILL_PAGE_SIZE }],
      [{ source: "pr_linked", after: null, limit: FORGE_BACKFILL_PAGE_SIZE }],
    ]);
    expect(steps).toEqual([
      "read-run_pull_requests-0",
      "observe-run_pull_requests-0",
      "read-pr_linked-0",
    ]);
    expect(sent[0]?.events).toEqual([
      { name: "forge/pull-request.observed", id: EVENT.id, data: EVENT.data },
    ]);
  });

  it("reads the next page from the last row of a full one", async () => {
    const runner = vi.fn((request: ForgeBackfillRequest) =>
      Promise.resolve(
        request.source === "pr_linked" && request.after === null
          ? { events: [], read: FORGE_BACKFILL_PAGE_SIZE, last: "fact-500" }
          : empty,
      ),
    );
    setForgeBackfillRunner(runner);
    await handler({ step });
    expect(runner.mock.calls.map(([request]) => request)).toEqual([
      { source: "run_pull_requests", after: null, limit: FORGE_BACKFILL_PAGE_SIZE },
      { source: "pr_linked", after: null, limit: FORGE_BACKFILL_PAGE_SIZE },
      { source: "pr_linked", after: "fact-500", limit: FORGE_BACKFILL_PAGE_SIZE },
    ]);
    // A page with no link to move sends nothing.
    expect(sent).toEqual([]);
  });

  it("stops at the page bound and says so (negative)", async () => {
    let n = 0;
    setForgeBackfillRunner((request) =>
      Promise.resolve(
        request.source === "run_pull_requests"
          ? { events: [], read: FORGE_BACKFILL_PAGE_SIZE, last: `row-${String(++n)}` }
          : empty,
      ),
    );
    await expect(handler({ step })).resolves.toEqual({
      read: FORGE_BACKFILL_PAGE_SIZE * FORGE_BACKFILL_MAX_PAGES,
      requested: 0,
      bounded: ["run_pull_requests"],
    });
    expect(n).toBe(FORGE_BACKFILL_MAX_PAGES);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("lets a runner failure reach Inngest, which retries (negative)", async () => {
    setForgeBackfillRunner(() => Promise.reject(new Error("postgres is down")));
    await expect(handler({ step })).rejects.toThrow("postgres is down");
    expect(sent).toEqual([]);
  });
});
