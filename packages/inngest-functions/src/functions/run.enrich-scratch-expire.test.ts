// The delete that runs a day after a run-enrichment job began its read
// (#4383). A cancelled job runs neither its own cleanup nor its failure
// handler, so this is what removes the scratch objects it kept. These tests
// hold the evidence store in memory and check what the function deletes and
// when.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
  /** Scratch objects by `<job run id>/<name>`. */
  objects: new Map<string, { bytes: Uint8Array; contentType: string }>(),
  deleted: [] as string[],
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({
    getScratch: async (_scope: unknown, jobRunId: string, name: string) => {
      const object = mocks.objects.get(`${jobRunId}/${name}`);
      if (object) return object;
      // What the storage driver throws for a key that holds nothing.
      throw Object.assign(new Error(`no object ${name}`), {
        name: "StorageNotFoundError",
      });
    },
    deleteScratch: async (
      _scope: unknown,
      jobRunId: string,
      names: readonly string[],
    ) => {
      for (const name of names) {
        mocks.objects.delete(`${jobRunId}/${name}`);
        mocks.deleted.push(`${jobRunId}/${name}`);
      }
    },
  }),
}));

import { NonRetriableError } from "@oxagen/functions";
import {
  ENRICHMENT_SCRATCH_TTL_MS,
  scratchExpiryEvent,
} from "../lib/run-enrichment-scratch";
import {
  RUN_ENRICH_SCRATCH_KEPT_EVENT,
  runEnrichScratchExpire,
} from "./run.enrich-scratch-expire";

type Handler = (args: {
  event: { data: unknown };
  step: {
    run: (id: string, fn: () => unknown) => unknown;
    sleep: (id: string, until: string | Date) => Promise<void>;
  };
}) => Promise<unknown>;
const handler = runEnrichScratchExpire as unknown as Handler;

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const JOB = "01K5ZJ3N9Q8R7S6T5V4W3X2Y1Z";
const OTHER_JOB = "01K5ZJ3N9Q8R7S6T5V4W3X2Y2A";
const READ_AT = new Date("2026-10-02T12:00:00.000Z");
const encode = (text: string) => new TextEncoder().encode(text);

function keep(jobRunId: string, names: readonly string[], chunks: number) {
  mocks.objects.set(`${jobRunId}/manifest`, {
    bytes: encode(JSON.stringify({ chunks })),
    contentType: "application/json",
  });
  for (const name of names)
    mocks.objects.set(`${jobRunId}/${name}`, {
      bytes: encode(`text of ${name}`),
      contentType: "text/plain",
    });
}

const order: string[] = [];
/** What the bucket held when the sleep ended. */
let heldAtWake: string[] = [];
const step = {
  run: (id: string, fn: () => unknown) => {
    order.push(id);
    return fn();
  },
  sleep: vi.fn(async (id: string, _until: string | Date) => {
    order.push(id);
    heldAtWake = [...mocks.objects.keys()];
  }),
};

beforeEach(() => {
  mocks.objects.clear();
  mocks.deleted = [];
  order.length = 0;
  heldAtWake = [];
  step.sleep.mockClear();
});

describe("run.enrich-scratch-expire", () => {
  it("triggers on the event run.enrich sends before its read keeps a chunk", () => {
    expect(mocks.configs[0]).toEqual({
      options: {
        id: "run.enrich-scratch-expire",
        retries: 3,
        concurrency: { limit: 2 },
      },
      trigger: { event: "run/enrich.scratch-kept" },
    });
    expect(RUN_ENRICH_SCRATCH_KEPT_EVENT).toBe("run/enrich.scratch-kept");
  });

  it("schedules the delete one day after the read began, once per job", () => {
    const event = scratchExpiryEvent(SCOPE, JOB, READ_AT);
    expect(ENRICHMENT_SCRATCH_TTL_MS).toBe(24 * 60 * 60_000);
    expect(event).toEqual({
      name: RUN_ENRICH_SCRATCH_KEPT_EVENT,
      id: `run-enrich-scratch:${JOB}`,
      data: {
        ...SCOPE,
        jobRunId: JOB,
        expiresAt: "2026-10-03T12:00:00.000Z",
      },
    });
  });

  it("sleeps until the expiry, then deletes the chunks and the manifest the job left", async () => {
    keep(JOB, ["chunk-0", "chunk-1"], 2);
    keep(OTHER_JOB, ["chunk-0"], 1);
    const { data } = scratchExpiryEvent(SCOPE, JOB, READ_AT);

    expect(await handler({ event: { data }, step })).toEqual({
      status: "expired",
      jobRunId: JOB,
    });

    expect(order).toEqual(["expiry", "discard-scratch"]);
    // The wake time is a Date. A string would be read as a duration.
    const until = step.sleep.mock.calls[0]?.[1];
    expect(until).toBeInstanceOf(Date);
    expect((until as Date).toISOString()).toBe("2026-10-03T12:00:00.000Z");
    // Nothing is deleted before the sleep ends.
    expect(heldAtWake).toContain(`${JOB}/chunk-0`);
    expect(mocks.deleted).toEqual([
      `${JOB}/chunk-0`,
      `${JOB}/chunk-1`,
      `${JOB}/manifest`,
    ]);
    // Another job's objects stay.
    expect([...mocks.objects.keys()].sort()).toEqual([
      `${OTHER_JOB}/chunk-0`,
      `${OTHER_JOB}/manifest`,
    ]);
  });

  it("deletes nothing when the job already cleaned up after itself", async () => {
    const { data } = scratchExpiryEvent(SCOPE, JOB, READ_AT);
    await handler({ event: { data }, step });
    expect(order).toEqual(["expiry", "discard-scratch"]);
    expect(mocks.deleted).toEqual([]);
  });

  it("refuses a malformed event without a retry (negative)", async () => {
    await expect(
      handler({
        event: { data: { ...SCOPE, jobRunId: JOB, expiresAt: "tomorrow" } },
        step,
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(step.sleep).not.toHaveBeenCalled();
    expect(mocks.deleted).toEqual([]);
  });
});
