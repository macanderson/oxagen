// The small pure pieces of the work dispatch path (ADR-251): how a refusal
// reaches a surface, the runtime tier a send forecasts, a pull request URL and
// a `pull_request` delivery, the work order a run names, the source text and
// the return reason a claim's prompt reads, and the contract's copies of the
// work record value lists.
import { describe, expect, it } from "vitest";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  WORK_ACTION_CLOSE_RESOLUTIONS,
  WORK_ACTION_CRITERION_TAGS,
  WORK_ACTION_DELIVERY_STATES,
  WORK_ACTION_INTENTS,
  WORK_ACTION_ITEM_STATES,
  WORK_ACTION_PROVENANCES,
} from "@oxagen/oxagen/contracts/work.order.shared";
import {
  BRIEF_CRITERION_TAGS,
  BRIEF_INTENTS,
  BRIEF_PROVENANCES,
  CLOSE_RESOLUTIONS,
  DELIVERY_STATES,
  type OrderProjection,
  WORK_ITEM_STATES,
  WorkRecordError,
  newFact,
} from "@oxagen/work/records";
import { asCapabilityRefusal } from "./errors";
import { MAX_PULL_REQUEST_NUMBER, MAX_REVERT_TARGETS, parsePullRequestUrl, revertedPullRequestsOf, workPullRequestDeliveryOf } from "./results";
import { returnedReasonBefore, sourceAt, workOrderNamedBy } from "./runtime";
import { forecastRuntimeTier } from "./target";

describe("asCapabilityRefusal", () => {
  it("passes a stale read and a forbidden state through as a conflict with the work code", () => {
    for (const code of ["stale_version", "stale_revision", "stale_brief", "stale_head", "not_allowed", "conflict"] as const) {
      const refusal = asCapabilityRefusal("accept_work_order", new WorkRecordError(code, "Read it again."));
      expect(refusal).toBeInstanceOf(HandlerError);
      expect(refusal).toMatchObject({ code: "conflict", reason: code, message: "Read it again." });
    }
  });

  it("maps forbidden and not_found to their own codes, and invalid_input to a capability error", () => {
    expect(asCapabilityRefusal("send_work_order", new WorkRecordError("forbidden", "x"))).toMatchObject({ code: "forbidden" });
    expect(asCapabilityRefusal("send_work_order", new WorkRecordError("not_found", "x"))).toMatchObject({ code: "not_found" });
    const invalid = asCapabilityRefusal("save_work_brief", new WorkRecordError("invalid_input", "bad"));
    expect(invalid).toBeInstanceOf(CapabilityError);
    expect(invalid).toMatchObject({ code: "invalid_input" });
  });

  it("leaves any other error as it is", () => {
    const error = new Error("database down");
    expect(asCapabilityRefusal("send_work_order", error)).toBe(error);
  });
});

describe("forecastRuntimeTier", () => {
  it("reads only what the control plane observed", () => {
    expect(forecastRuntimeTier({ containmentRequired: true, hostMode: "observe", gatewayLastSeenAt: null })).toBe("contained");
    expect(forecastRuntimeTier({ containmentRequired: false, hostMode: "observe", gatewayLastSeenAt: new Date() })).toBe("observe");
    expect(forecastRuntimeTier({ containmentRequired: false, hostMode: "enforce", gatewayLastSeenAt: new Date() })).toBe("gateway");
    expect(forecastRuntimeTier({ containmentRequired: false, hostMode: "enforce", gatewayLastSeenAt: null })).toBe("harness");
  });
});

describe("parsePullRequestUrl", () => {
  it("reads a GitHub pull request URL, in lower case", () => {
    expect(parsePullRequestUrl("https://github.com/AIntel/Platform/pull/612")).toEqual({ repository: "aintel/platform", number: 612 });
    expect(parsePullRequestUrl("https://github.com/aintel/platform/pull/612/files")).toEqual({ repository: "aintel/platform", number: 612 });
  });

  it("refuses anything else", () => {
    for (const url of [
      "https://gitlab.com/a/b/-/merge_requests/1",
      "https://github.com/a/b/issues/3",
      "http://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/0",
      // Larger than the pull request number column holds.
      "https://github.com/a/b/pull/2147483648",
    ]) {
      expect(parsePullRequestUrl(url), url).toBeNull();
    }
  });
});

describe("workPullRequestDeliveryOf", () => {
  const body = {
    action: "closed",
    repository: { full_name: "AIntel/Platform" },
    pull_request: {
      number: 612,
      state: "closed",
      merged: true,
      merge_commit_sha: "9".repeat(40),
      merged_at: "2026-10-02T10:00:00Z",
      updated_at: "2026-10-02T10:00:01Z",
      head: { sha: "1".repeat(40) },
      base: { ref: "main" },
    },
  };

  it("reads the pull request a delivery describes", () => {
    expect(workPullRequestDeliveryOf(body)).toEqual({
      repository: "aintel/platform",
      number: 612,
      reverts: [],
      pull: {
        headSha: "1".repeat(40),
        baseRef: "main",
        state: "closed",
        merged: true,
        mergeCommitSha: "9".repeat(40),
        mergedAt: "2026-10-02T10:00:00Z",
        updatedAt: "2026-10-02T10:00:01Z",
      },
    });
  });

  it("drops a head that is not a commit id, and a delivery with no pull request", () => {
    expect(workPullRequestDeliveryOf({ ...body, pull_request: { ...body.pull_request, head: { sha: "main" } } })?.pull.headSha).toBeNull();
    expect(workPullRequestDeliveryOf({ action: "opened", repository: body.repository })).toBeNull();
  });
});

describe("revertedPullRequestsOf", () => {
  it("reads the line GitHub's Revert button writes, in the delivering repository", () => {
    expect(revertedPullRequestsOf("Reverts AIntel/Platform#612", "aintel/platform", 640)).toEqual([612]);
    expect(revertedPullRequestsOf("Broke sign-in.\r\n\r\n  reverts aintel/platform#7\r\nReverts aintel/platform#9.", "AIntel/Platform", 640)).toEqual([7, 9]);
  });

  it("names nothing for a revert without the full link", () => {
    const none = [
      null,
      "",
      // A bare number, and a git revert's commit line.
      "Reverts #612",
      "This reverts commit 9999999999999999999999999999999999999999.",
      // Not at the start of a line.
      "This change Reverts aintel/platform#612",
      // A pull request in another repository: a merge here changes nothing there.
      "Reverts aintel/other#612",
      // The pull request itself.
      "Reverts aintel/platform#640",
      "Reverts aintel/platform#612abc",
      // Larger than any pull request number a fact can carry.
      `Reverts aintel/platform#${MAX_PULL_REQUEST_NUMBER + 1}`,
    ];
    for (const body of none) expect(revertedPullRequestsOf(body, "aintel/platform", 640), String(body)).toEqual([]);
  });

  it("names each pull request once, up to its cap", () => {
    expect(revertedPullRequestsOf("Reverts aintel/platform#5\nReverts aintel/platform#5", "aintel/platform", 640)).toEqual([5]);
    const many = Array.from({ length: MAX_REVERT_TARGETS + 5 }, (_, index) => `Reverts aintel/platform#${index + 1}`).join("\n");
    expect(revertedPullRequestsOf(many, "aintel/platform", 640)).toHaveLength(MAX_REVERT_TARGETS);
  });

  it("reaches the delivery only from the merge of the reverting pull request", () => {
    const merged = {
      action: "closed",
      repository: { full_name: "aintel/platform" },
      pull_request: { number: 640, body: "Reverts aintel/platform#612", state: "closed", merged: true, head: { sha: "1".repeat(40) } },
    };
    expect(workPullRequestDeliveryOf(merged)?.reverts).toEqual([612]);
    expect(revertedPullRequestsOf(`Reverts aintel/platform#${MAX_PULL_REQUEST_NUMBER}`, "aintel/platform", 640)).toEqual([MAX_PULL_REQUEST_NUMBER]);
    // An edit after the merge, a close without merging, and an open pull request name nothing.
    expect(workPullRequestDeliveryOf({ ...merged, action: "edited" })?.reverts).toEqual([]);
    expect(workPullRequestDeliveryOf({ ...merged, pull_request: { ...merged.pull_request, merged: false } })?.reverts).toEqual([]);
    expect(workPullRequestDeliveryOf({ ...merged, action: "opened", pull_request: { ...merged.pull_request, state: "open", merged: false } })?.reverts).toEqual([]);
    expect(workPullRequestDeliveryOf({ ...merged, pull_request: { ...merged.pull_request, body: 7 } })?.reverts).toEqual([]);
  });
});

describe("workOrderNamedBy", () => {
  it("reads the work order a run names, under either spelling", () => {
    expect(workOrderNamedBy([{ attrs: {} }, { attrs: { "oxagen.work_order.id": "wo_abc" } }])).toBe("wo_abc");
    expect(workOrderNamedBy([{ attrs: { "client_claimed.oxagen.work_order.id": "wo_def" } }])).toBe("wo_def");
  });

  it("ignores a value that is not a work order id", () => {
    expect(workOrderNamedBy([{ attrs: { "oxagen.work_order.id": "drop table" } }, {}])).toBeNull();
  });
});

describe("sourceAt", () => {
  const snapshot = (subject: string) => ({ digest: `sha256:${"0".repeat(64)}` as const, subject, description: null, labels: [] });
  const facts = [
    newFact({ kind: "collected", source: "provider", itemRevision: 1, actor: "github", occurredAt: "2026-10-02T09:00:00.000Z", dedupeKey: "a", data: snapshot("First") }),
    newFact({
      kind: "source_changed",
      source: "provider",
      itemRevision: 2,
      actor: "github",
      occurredAt: "2026-10-02T09:30:00.000Z",
      dedupeKey: "b",
      data: { ...snapshot("Second"), previous_digest: null },
    }),
  ];

  it("reads the text at the revision the send went out on, not a later one", () => {
    expect(sourceAt({ facts, sourceUrl: null }, 1)?.subject).toBe("First");
    expect(sourceAt({ facts, sourceUrl: "https://x" }, 2)).toMatchObject({ subject: "Second", revision: 2, url: "https://x" });
  });
});

describe("returnedReasonBefore", () => {
  const order = (send: number, reason: string | null) =>
    ({ send, returned: reason === null ? null : { reason, actor: "m", at: "t" } }) as unknown as OrderProjection;

  it("reads the return of the send just before, in the current cycle", () => {
    const orders = [order(1, "Old reason"), order(2, "Add the test."), order(3, null)];
    expect(returnedReasonBefore(orders, 3, 0)).toBe("Add the test.");
    expect(returnedReasonBefore(orders, 2, 0)).toBe("Old reason");
    expect(returnedReasonBefore(orders, 3, 2)).toBeNull();
  });
});

describe("the contract's copies of the work record lists", () => {
  it("equal @oxagen/work/records", () => {
    expect([...WORK_ACTION_ITEM_STATES]).toEqual([...WORK_ITEM_STATES]);
    expect([...WORK_ACTION_DELIVERY_STATES]).toEqual([...DELIVERY_STATES]);
    expect([...WORK_ACTION_CLOSE_RESOLUTIONS]).toEqual([...CLOSE_RESOLUTIONS]);
    expect([...WORK_ACTION_CRITERION_TAGS]).toEqual([...BRIEF_CRITERION_TAGS]);
    expect([...WORK_ACTION_INTENTS]).toEqual([...BRIEF_INTENTS]);
    expect([...WORK_ACTION_PROVENANCES]).toEqual([...BRIEF_PROVENANCES]);
  });
});
