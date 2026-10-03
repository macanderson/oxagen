// The durable pull request sync (ADR-288): an upsert step, then a capture
// step and a record step only when the head has no stored diff, then one
// diff-ready event per newly stored revision. The runner is the seam
// `@oxagen/handlers` installs at boot, so these tests install a fake one and
// assert what it receives and which steps ran.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configs: [] as { options: unknown; trigger: unknown }[],
}));
vi.mock("../create-function", () => ({
  createFunction: (options: unknown, trigger: unknown, handler: unknown) => {
    mocks.configs.push({ options, trigger });
    return [handler];
  },
}));

import { NonRetriableError } from "@oxagen/functions";
import {
  type ForgePullRequestCapture,
  type ForgePullRequestSyncRunner,
  setForgePullRequestSyncRunner,
} from "../lib/forge-pull-request-sync-runner";
import {
  FORGE_PULL_REQUEST_DIFF_READY_EVENT,
  FORGE_PULL_REQUEST_OBSERVED_EVENT,
  forgePullRequestSync,
  forgePullRequestSyncSchema,
} from "./forge.pull-request-sync";

type Handler = (args: {
  event: { data: unknown };
  step: {
    run: (id: string, fn: () => unknown) => unknown;
    sendEvent: (id: string, event: unknown) => Promise<void>;
  };
}) => Promise<unknown>;
const handler = forgePullRequestSync as unknown as Handler;

const HEAD = "a".repeat(40);
const DATA = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  provider: "github",
  repository: "acme/api",
  number: 42,
  pullKey: "0192d4a8-7c1e-7a00-8000-0000000c0e01:github:acme/api#42",
  link: { rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1", opened: true },
};
const TARGET = {
  headSha: HEAD,
  baseSha: "b".repeat(40),
  baseRef: "main",
  mergeBaseSha: null,
  providerRepositoryId: "991",
  number: 42,
};
const CAPTURE: ForgePullRequestCapture = {
  diffStatus: "stored",
  diffStore: "s3",
  diffKey: "pr-diffs/o/w/github/991/42/aaaa.diff",
  diffSha256: "c".repeat(64),
  diffBytes: 120,
  mergeBaseSha: "d".repeat(40),
  files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
  filesChanged: 1,
  additions: 1,
  deletions: 0,
  complete: true,
  limitations: [],
};

const steps: string[] = [];
const sent: { id: string; event: unknown }[] = [];
const step = {
  run: (id: string, fn: () => unknown) => {
    steps.push(id);
    return fn();
  },
  sendEvent: (id: string, event: unknown) => {
    steps.push(id);
    sent.push({ id, event });
    return Promise.resolve();
  },
};

function runner(
  over: Partial<ForgePullRequestSyncRunner> = {},
): ForgePullRequestSyncRunner {
  return {
    upsert: vi.fn(() =>
      Promise.resolve({
        outcome: "recorded" as const,
        pullRequestId: "pr-1",
        target: TARGET,
        needsCapture: true,
        links: 2,
      }),
    ),
    capture: vi.fn(() => Promise.resolve(CAPTURE)),
    record: vi.fn(() =>
      Promise.resolve({
        revisionId: "rev-1",
        diffStatus: "stored" as const,
        newlyStored: true,
      }),
    ),
    ...over,
  };
}

beforeEach(() => {
  steps.length = 0;
  sent.length = 0;
});

describe("forge.pull-request-sync", () => {
  it("triggers on the observed event, one run per pull request and two per workspace", () => {
    expect(mocks.configs[0]).toEqual({
      options: {
        id: "forge/pull-request-sync",
        retries: 4,
        concurrency: [
          { limit: 1, key: "event.data.pullKey" },
          { limit: 2, key: "event.data.workspaceId" },
        ],
      },
      trigger: { event: "forge/pull-request.observed" },
    });
    expect(FORGE_PULL_REQUEST_OBSERVED_EVENT).toBe("forge/pull-request.observed");
    expect(FORGE_PULL_REQUEST_DIFF_READY_EVENT).toBe(
      "forge/pull-request-diff.ready",
    );
  });

  it("upserts, captures, records, and announces a newly stored diff, each in its own step", async () => {
    const fake = runner();
    setForgePullRequestSyncRunner(fake);
    await expect(handler({ event: { data: DATA }, step })).resolves.toEqual({
      upserted: expect.objectContaining({ pullRequestId: "pr-1" }),
      diffStatus: "stored",
      newlyStored: true,
    });
    expect(steps).toEqual([
      "upsert-pull-request",
      "capture-diff",
      "record-revision",
      "diff-ready",
    ]);
    expect(fake.upsert).toHaveBeenCalledWith(DATA);
    expect(fake.capture).toHaveBeenCalledWith(DATA, "pr-1", TARGET);
    expect(fake.record).toHaveBeenCalledWith(DATA, "pr-1", TARGET, CAPTURE);
    expect(sent[0]?.event).toEqual({
      name: "forge/pull-request-diff.ready",
      id: "forge-diff-ready:rev-1",
      data: {
        orgId: DATA.orgId,
        workspaceId: DATA.workspaceId,
        pullRequestId: "pr-1",
        revisionId: "rev-1",
        provider: "github",
        repository: "acme/api",
        number: 42,
        headSha: HEAD,
        diffKey: CAPTURE.diffKey,
        diffSha256: CAPTURE.diffSha256,
      },
    });
  });

  it("reads no diff for a head that already has one, so a label change costs one step", async () => {
    const fake = runner({
      upsert: vi.fn(() =>
        Promise.resolve({
          outcome: "recorded" as const,
          pullRequestId: "pr-1",
          target: TARGET,
          needsCapture: false,
          links: 0,
        }),
      ),
    });
    setForgePullRequestSyncRunner(fake);
    await handler({ event: { data: DATA }, step });
    expect(steps).toEqual(["upsert-pull-request"]);
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("stops after the upsert when no connection reaches the repository (negative)", async () => {
    const fake = runner({
      upsert: vi.fn(() =>
        Promise.resolve({
          outcome: "no_connection" as const,
          needsCapture: false,
          links: 0,
        }),
      ),
    });
    setForgePullRequestSyncRunner(fake);
    await expect(handler({ event: { data: DATA }, step })).resolves.toEqual({
      upserted: { outcome: "no_connection", needsCapture: false, links: 0 },
    });
    expect(steps).toEqual(["upsert-pull-request"]);
  });

  it("sends no diff-ready event when the record step stored nothing new", async () => {
    const fake = runner({
      record: vi.fn(() =>
        Promise.resolve({
          revisionId: "rev-1",
          diffStatus: "unconfigured" as const,
          newlyStored: false,
        }),
      ),
    });
    setForgePullRequestSyncRunner(fake);
    await handler({ event: { data: DATA }, step });
    expect(steps).toEqual([
      "upsert-pull-request",
      "capture-diff",
      "record-revision",
    ]);
    expect(sent).toEqual([]);
  });

  it("hands the runner the work order a backfill event names", async () => {
    const fake = runner();
    setForgePullRequestSyncRunner(fake);
    const data = { ...DATA, workOrderId: "0192d4a8-7c1e-7a00-8000-0000000000f1" };
    await handler({ event: { data }, step });
    expect(fake.upsert).toHaveBeenCalledWith(data);
    expect(forgePullRequestSyncSchema.safeParse(data).success).toBe(true);
  });

  it("refuses a work order that is not a uuid without retrying (negative)", async () => {
    setForgePullRequestSyncRunner(runner());
    await expect(
      handler({ event: { data: { ...DATA, workOrderId: "wo_12" } }, step }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(steps).toEqual([]);
  });

  it("refuses malformed event data without retrying (negative)", async () => {
    setForgePullRequestSyncRunner(runner());
    await expect(
      handler({ event: { data: { ...DATA, number: 0 } }, step }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    await expect(
      handler({
        event: {
          data: {
            ...DATA,
            facts: { headSha: "not-a-sha" },
          },
        },
        step,
      }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(steps).toEqual([]);
  });
});
