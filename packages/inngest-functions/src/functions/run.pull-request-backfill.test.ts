// The durable pull request backfill (ADR-189): one runner call per recorded
// link, inside one step. The runner is the seam `@oxagen/handlers` installs
// at boot, so these tests install a fake one and assert what it receives.
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
import { setPullRequestBackfillRunner } from "../lib/run-pull-request-backfill-runner";
import {
  RUN_PULL_REQUEST_LINKED_EVENT,
  runPullRequestBackfill,
} from "./run.pull-request-backfill";

type Handler = (args: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => unknown };
}) => Promise<unknown>;
const handler = runPullRequestBackfill as unknown as Handler;

const DATA = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  url: "https://github.com/acme/api/pull/42",
};

const steps: string[] = [];
const step = {
  run: (id: string, fn: () => unknown) => {
    steps.push(id);
    return fn();
  },
};

beforeEach(() => {
  steps.length = 0;
});

describe("run.pull-request-backfill", () => {
  it("triggers on the linked event, bounded per workspace", () => {
    expect(mocks.configs[0]).toEqual({
      options: {
        id: "run/pull-request-backfill",
        retries: 3,
        concurrency: { limit: 2, key: "event.data.workspaceId" },
      },
      trigger: { event: "run/pull-request.linked" },
    });
    expect(RUN_PULL_REQUEST_LINKED_EVENT).toBe("run/pull-request.linked");
  });

  it("hands the runner the link, in one step, and answers what it did", async () => {
    const runner = vi.fn(() =>
      Promise.resolve({ outcome: "recorded", rows: 1 }),
    );
    setPullRequestBackfillRunner(runner);
    await expect(handler({ event: { data: DATA }, step })).resolves.toEqual({
      outcome: "recorded",
      rows: 1,
    });
    expect(runner).toHaveBeenCalledWith(DATA);
    expect(steps).toEqual(["backfill"]);
  });

  it("refuses a malformed event without a retry (negative)", async () => {
    const runner = vi.fn();
    setPullRequestBackfillRunner(runner);
    await expect(
      handler({ event: { data: { ...DATA, url: "not a url" } }, step }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(runner).not.toHaveBeenCalled();
  });

  it("lets a runner failure reach Inngest, which retries (negative)", async () => {
    setPullRequestBackfillRunner(() => Promise.reject(new Error("github 502")));
    await expect(handler({ event: { data: DATA }, step })).rejects.toThrow(
      "github 502",
    );
  });
});
