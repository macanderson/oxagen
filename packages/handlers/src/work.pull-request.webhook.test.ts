// GitHub App deliveries recorded on work orders (P1-04, ADR-251). Every seam
// is a fake, so these cases read what each recorder asks of the workspaces
// connected to the delivering installation: every workspace is written, one
// workspace's failure never stops the others, and a delivery that names no
// pull request or no check result writes nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderProjection } from "@oxagen/work/records";
import { githubPullRequestStateDeps } from "./github.pull-request.webhook";
import { workPullRequestDeliveryOf } from "./lib/work-records/results";
import {
  type WorkChecksDelivery,
  type WorkChecksWebhookDeps,
  type WorkOrderRef,
  type WorkPullRequestWebhookDeps,
  isOrderAtHead,
  recordWorkOrderChecks,
  recordWorkOrderPullRequest,
  workChecksDeliveryOf,
  workChecksWebhookDeps,
  workPullRequestWebhookDeps,
} from "./work.pull-request.webhook";

const ORG_A = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000000a",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000aa",
};
const ORG_B = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000000b",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000bb",
};
const INSTALLATION = "61200044";
const NOW = new Date("2026-10-02T09:30:00.000Z");
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);

/** A `synchronize` delivery for aintel/platform#612, its head at SHA1. */
const PULL_REQUEST = {
  action: "synchronize",
  installation: { id: Number(INSTALLATION) },
  repository: { full_name: "AIntel/Platform" },
  pull_request: {
    number: 612,
    state: "open",
    merged: false,
    head: { sha: SHA1 },
    base: { ref: "main" },
    updated_at: "2026-10-02T09:10:00Z",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordWorkOrderPullRequest", () => {
  function deps(scopes: (typeof ORG_A)[]): WorkPullRequestWebhookDeps {
    return {
      connectedScopes: vi.fn(async () => scopes),
      record: vi.fn<WorkPullRequestWebhookDeps["record"]>(async (scope) => (scope.orgId === ORG_A.orgId ? 2 : 1)),
      now: () => NOW,
    };
  }

  it("records the delivery in every workspace connected to the installation", async () => {
    const d = deps([ORG_A, ORG_B]);
    const recorded = await recordWorkOrderPullRequest({ body: PULL_REQUEST, installationId: INSTALLATION }, d);
    expect(recorded).toBe(3);
    expect(d.connectedScopes).toHaveBeenCalledWith(INSTALLATION);
    const delivery = workPullRequestDeliveryOf(PULL_REQUEST);
    expect(delivery).toMatchObject({ repository: "aintel/platform", number: 612, pull: { headSha: SHA1 } });
    expect(d.record).toHaveBeenCalledTimes(2);
    expect(d.record).toHaveBeenNthCalledWith(1, ORG_A, delivery, NOW);
    expect(d.record).toHaveBeenNthCalledWith(2, ORG_B, delivery, NOW);
  });

  it("keeps going after one workspace fails, then throws an AggregateError naming 1 of 2", async () => {
    const d = deps([ORG_A, ORG_B]);
    const failure = new Error("pg down");
    vi.mocked(d.record).mockRejectedValueOnce(failure);
    const error = await recordWorkOrderPullRequest({ body: PULL_REQUEST, installationId: INSTALLATION }, d).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain("1 of 2 workspaces");
    expect((error as AggregateError).errors).toEqual([failure]);
    // The second workspace still recorded.
    expect(d.record).toHaveBeenCalledTimes(2);
    expect(d.record).toHaveBeenLastCalledWith(ORG_B, expect.anything(), NOW);
  });

  it("records nothing, and reads no workspace, for a body with no pull request", async () => {
    const d = deps([ORG_A]);
    const { pull_request: _pr, ...noPullRequest } = PULL_REQUEST;
    for (const body of [noPullRequest, { ...PULL_REQUEST, pull_request: { ...PULL_REQUEST.pull_request, number: 0 } }, {}]) {
      await expect(recordWorkOrderPullRequest({ body, installationId: INSTALLATION }, d)).resolves.toBe(0);
    }
    expect(d.connectedScopes).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it("records nothing when no workspace connects the installation", async () => {
    const d = deps([]);
    await expect(recordWorkOrderPullRequest({ body: PULL_REQUEST, installationId: INSTALLATION }, d)).resolves.toBe(0);
    expect(d.record).not.toHaveBeenCalled();
  });
});

describe("workChecksDeliveryOf", () => {
  const repository = { full_name: "AIntel/Platform" };

  it("reads the commit a check run, a check suite, or a commit status reports on, with the repository in lower case", () => {
    const expected: WorkChecksDelivery = { repository: "aintel/platform", headSha: SHA1 };
    expect(workChecksDeliveryOf({ action: "completed", repository, check_run: { name: "test", head_sha: SHA1 } })).toEqual(expected);
    expect(workChecksDeliveryOf({ action: "created", repository, check_run: { name: "test", head_sha: SHA1 } })).toEqual(expected);
    expect(workChecksDeliveryOf({ action: "completed", repository, check_suite: { head_sha: SHA1 } })).toEqual(expected);
    expect(workChecksDeliveryOf({ repository, sha: SHA1, context: "ci/circleci", state: "failure" })).toEqual(expected);
  });

  it.each([
    ["a request to run the checks again", { action: "rerequested", repository, check_suite: { head_sha: SHA1 } }],
    ["a request for the suite", { action: "requested", repository, check_suite: { head_sha: SHA1 } }],
    ["a requested action", { action: "requested_action", repository, check_run: { head_sha: SHA1 } }],
    ["no repository", { action: "completed", check_run: { head_sha: SHA1 } }],
    ["a repository with no owner", { action: "completed", repository: { full_name: "platform" }, check_run: { head_sha: SHA1 } }],
    ["no commit", { action: "completed", repository, check_run: { name: "test" } }],
    ["a short commit", { repository, sha: "1234567" }],
    ["an upper case commit", { repository, sha: SHA1.replace(/1/g, "A") }],
  ])("reads %s as nothing", (_label, body) => {
    expect(workChecksDeliveryOf(body)).toBeNull();
  });
});

describe("isOrderAtHead", () => {
  const delivery: WorkChecksDelivery = { repository: "aintel/platform", headSha: SHA1 };
  const open: Pick<OrderProjection, "closed" | "pullRequest" | "head"> = {
    closed: false,
    pullRequest: { repository: "AIntel/Platform", number: 612 },
    head: SHA1,
  };

  it("holds for an open send whose pull request's head is the commit", () => {
    expect(isOrderAtHead(open, delivery)).toBe(true);
  });

  it("fails for a closed send, another head, another repository, or no pull request", () => {
    expect(isOrderAtHead({ ...open, closed: true }, delivery)).toBe(false);
    expect(isOrderAtHead({ ...open, head: SHA2 }, delivery)).toBe(false);
    expect(isOrderAtHead({ ...open, head: null }, delivery)).toBe(false);
    expect(isOrderAtHead({ ...open, pullRequest: { repository: "aintel/website", number: 612 } }, delivery)).toBe(false);
    expect(isOrderAtHead({ ...open, pullRequest: null }, delivery)).toBe(false);
  });
});

describe("recordWorkOrderChecks", () => {
  const CHECK_RUN = {
    action: "completed",
    installation: { id: Number(INSTALLATION) },
    repository: { full_name: "AIntel/Platform" },
    check_run: { name: "test", head_sha: SHA1, status: "completed", conclusion: "failure" },
  };
  const SEND_A1: WorkOrderRef = { itemId: "item-a1", orderId: "order-a1" };
  const SEND_A2: WorkOrderRef = { itemId: "item-a2", orderId: "order-a2" };
  const SEND_B1: WorkOrderRef = { itemId: "item-b1", orderId: "order-b1" };

  function deps(sends: Map<string, WorkOrderRef[]>, scopes: (typeof ORG_A)[] = [ORG_A, ORG_B]): WorkChecksWebhookDeps {
    return {
      connectedScopes: vi.fn(async () => scopes),
      ordersAtHead: vi.fn<WorkChecksWebhookDeps["ordersAtHead"]>(async (scope) => sends.get(scope.orgId) ?? []),
      recordEvidence: vi.fn<WorkChecksWebhookDeps["recordEvidence"]>(async () => 2),
      now: () => NOW,
    };
  }

  it("reads the evidence of every open send at the commit, in every workspace connected to the installation", async () => {
    const d = deps(
      new Map([
        [ORG_A.orgId, [SEND_A1, SEND_A2]],
        [ORG_B.orgId, [SEND_B1]],
      ]),
    );
    const recorded = await recordWorkOrderChecks({ body: CHECK_RUN, installationId: INSTALLATION }, d);
    expect(recorded).toBe(6);
    expect(d.connectedScopes).toHaveBeenCalledWith(INSTALLATION);
    const delivery: WorkChecksDelivery = { repository: "aintel/platform", headSha: SHA1 };
    expect(d.ordersAtHead).toHaveBeenNthCalledWith(1, ORG_A, delivery);
    expect(d.ordersAtHead).toHaveBeenNthCalledWith(2, ORG_B, delivery);
    expect(vi.mocked(d.recordEvidence).mock.calls).toEqual([
      [ORG_A, SEND_A1, NOW],
      [ORG_A, SEND_A2, NOW],
      [ORG_B, SEND_B1, NOW],
    ]);
  });

  it("keeps going after one workspace or one send fails, then throws the failures together", async () => {
    const d = deps(
      new Map([
        [ORG_A.orgId, [SEND_A1, SEND_A2]],
        [ORG_B.orgId, [SEND_B1]],
      ]),
      [ORG_A, ORG_B, { orgId: "0192d4a8-7c1e-7a00-8000-00000000000c", workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000cc" }],
    );
    const sendFailure = new Error("GitHub token revoked");
    const scopeFailure = new Error("pg down");
    vi.mocked(d.recordEvidence).mockRejectedValueOnce(sendFailure);
    vi.mocked(d.ordersAtHead).mockImplementation(async (scope) => {
      if (scope.orgId === ORG_B.orgId) throw scopeFailure;
      return scope.orgId === ORG_A.orgId ? [SEND_A1, SEND_A2] : [];
    });
    const error = await recordWorkOrderChecks({ body: CHECK_RUN, installationId: INSTALLATION }, d).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([sendFailure, scopeFailure]);
    expect((error as AggregateError).message).toContain("2 reads of the checks on aintel/platform@");
    // The second send in the first workspace and the third workspace still ran.
    expect(vi.mocked(d.recordEvidence).mock.calls).toEqual([
      [ORG_A, SEND_A1, NOW],
      [ORG_A, SEND_A2, NOW],
    ]);
    expect(d.ordersAtHead).toHaveBeenCalledTimes(3);
  });

  it("records nothing, and reads no workspace, for a delivery that reports no result", async () => {
    const d = deps(new Map([[ORG_A.orgId, [SEND_A1]]]));
    const rerequested = { ...CHECK_RUN, action: "rerequested" };
    const noCommit = { ...CHECK_RUN, check_run: { name: "test" } };
    for (const body of [rerequested, noCommit, {}]) {
      await expect(recordWorkOrderChecks({ body, installationId: INSTALLATION }, d)).resolves.toBe(0);
    }
    expect(d.connectedScopes).not.toHaveBeenCalled();
    expect(d.recordEvidence).not.toHaveBeenCalled();
  });

  it("records nothing when no send is at the commit", async () => {
    const d = deps(new Map());
    await expect(recordWorkOrderChecks({ body: CHECK_RUN, installationId: INSTALLATION }, d)).resolves.toBe(0);
    expect(d.ordersAtHead).toHaveBeenCalledTimes(2);
    expect(d.recordEvidence).not.toHaveBeenCalled();
  });
});

describe("the default seams", () => {
  it("read the connected workspaces from the GitHub source connections", async () => {
    const connected = vi.spyOn(githubPullRequestStateDeps, "connectedScopes").mockResolvedValue([ORG_A]);
    await expect(workPullRequestWebhookDeps.connectedScopes(INSTALLATION)).resolves.toEqual([ORG_A]);
    await expect(workChecksWebhookDeps.connectedScopes(INSTALLATION)).resolves.toEqual([ORG_A]);
    expect(connected).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenCalledWith(INSTALLATION);
  });
});
