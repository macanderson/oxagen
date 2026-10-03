// The witness's queue (ADR-294): a queue step for each stored revision, then
// a certify step for a row that is still pending. The runner is the seam
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
  type ForgeCertificationQueueOutcome,
  type ForgeRevisionCertificationRunner,
  setForgeRevisionCertificationRunner,
} from "../lib/forge-revision-certification-runner";
import {
  forgeRevisionCertification,
  forgeRevisionCertificationSchema,
} from "./forge.revision-certification";

type Handler = (args: {
  event: { data: unknown };
  step: { run: (id: string, fn: () => unknown) => unknown };
}) => Promise<unknown>;
const handler = forgeRevisionCertification as unknown as Handler;

// The data `forge.pull-request-sync` sends with `forge/pull-request-diff.ready`.
const DATA = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  pullRequestId: "0192d4a8-7c1e-7a00-8000-0000000c0f01",
  revisionId: "0192d4a8-7c1e-7a00-8000-0000000c0f02",
  provider: "github",
  repository: "acme/api",
  number: 42,
  headSha: "a".repeat(40),
  diffKey: "pr-diffs/o/w/github/991/42/aaaa.diff",
  diffSha256: "c".repeat(64),
};

const steps: string[] = [];
const step = {
  run: (id: string, fn: () => unknown) => {
    steps.push(id);
    return fn();
  },
};

function runner(
  queued: ForgeCertificationQueueOutcome = {
    outcome: "queued",
    certificationId: "rcf_1",
    state: "pending",
  },
): ForgeRevisionCertificationRunner {
  return {
    queue: vi.fn(() => Promise.resolve(queued)),
    certify: vi.fn(() =>
      Promise.resolve({ state: "pending" as const, reason: "witness_not_built" }),
    ),
  };
}

beforeEach(() => {
  steps.length = 0;
});

describe("forge.revision-certification", () => {
  it("triggers on the diff-ready event, five revisions per workspace at once", () => {
    expect(mocks.configs[0]).toEqual({
      options: {
        id: "forge/revision-certification",
        retries: 4,
        concurrency: [{ limit: 5, key: "event.data.workspaceId" }],
      },
      trigger: { event: "forge/pull-request-diff.ready" },
    });
  });

  it("queues the revision, then asks the witness to certify it, each in its own step", async () => {
    const fake = runner();
    setForgeRevisionCertificationRunner(fake);
    await expect(handler({ event: { data: DATA }, step })).resolves.toEqual({
      queued: { outcome: "queued", certificationId: "rcf_1", state: "pending" },
      certified: { state: "pending", reason: "witness_not_built" },
    });
    expect(steps).toEqual(["queue-certification", "certify"]);
    expect(fake.queue).toHaveBeenCalledWith(DATA);
    expect(fake.certify).toHaveBeenCalledWith(DATA, "rcf_1");
  });

  it("asks again for a row an earlier delivery queued that is still pending", async () => {
    const fake = runner({
      outcome: "existing",
      certificationId: "rcf_1",
      state: "pending",
    });
    setForgeRevisionCertificationRunner(fake);
    await handler({ event: { data: DATA }, step });
    expect(steps).toEqual(["queue-certification", "certify"]);
  });

  it("never certifies a row the witness already decided (negative)", async () => {
    const fake = runner({
      outcome: "existing",
      certificationId: "rcf_1",
      state: "certified",
    });
    setForgeRevisionCertificationRunner(fake);
    await handler({ event: { data: DATA }, step });
    expect(steps).toEqual(["queue-certification"]);
    expect(fake.certify).not.toHaveBeenCalled();
  });

  it("stops after the queue step when the revision is gone (negative)", async () => {
    const fake = runner({ outcome: "gone", certificationId: null, state: null });
    setForgeRevisionCertificationRunner(fake);
    await expect(handler({ event: { data: DATA }, step })).resolves.toEqual({
      queued: { outcome: "gone", certificationId: null, state: null },
    });
    expect(fake.certify).not.toHaveBeenCalled();
  });

  it("refuses malformed event data without a retry or a runner call (negative)", async () => {
    const fake = runner();
    setForgeRevisionCertificationRunner(fake);
    await expect(
      handler({ event: { data: { ...DATA, diffSha256: "not-a-digest" } }, step }),
    ).rejects.toBeInstanceOf(NonRetriableError);
    expect(fake.queue).not.toHaveBeenCalled();
    expect(steps).toEqual([]);
  });

  it("accepts exactly the data the sync sends", () => {
    expect(forgeRevisionCertificationSchema.safeParse(DATA).success).toBe(true);
    expect(
      forgeRevisionCertificationSchema.safeParse({ ...DATA, provider: "bitbucket" })
        .success,
    ).toBe(false);
  });
});
