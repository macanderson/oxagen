// @vitest-environment jsdom
// The Work item page over a fake DataSource, one render per state the
// records produce (roadmap mockups/pages/work-item.md, States): the status
// word, the head's actions in order with the one primary last, and what each
// panel shows in that state, each with an axe check (INV-26). The read
// failures (404, denied, error) and the read-only viewer are here too. The
// dialogs and the writes they make are in work-item.dialogs.test.tsx, and the
// actions' capability input in ../actions.test.ts. The Changes panel draws
// the item's change set from Oxagen's own pull request store, and each send
// opens its own through the lane's action (ADR-292).
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeSet } from "@/data/contracts/changes";
import { WorkItemDetail, WorkTargetList } from "@/data/contracts/work";
import { type Read, readError, readOk } from "@/data/read";
import { changeSet, revisionDiff } from "@/test/change-views";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  acceptedItem,
  changedItem,
  checkFailedItem,
  checkMissingItem,
  closedDuplicateItem,
  closedWithoutMergingItem,
  costUnknownItem,
  doneItem,
  draftBriefItem,
  inReviewItem,
  mergedBeforeReviewItem,
  needsInfoItem,
  noAnswerItem,
  otherPullItem,
  noRequiredChecksItem,
  possibleDuplicateItem,
  readyItem,
  runningItem,
  sendRejectedItem,
  staleEvidenceItem,
  stoppingItem,
  triageDraftItem,
  triageFailedItem,
  triagingItem,
  twoPullsItem,
  unrecordedPullItem,
  viewerOnlyItem,
  waitingItem,
  workItem,
  workItemSource,
  workTargets,
} from "./work-item.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { router } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const { readChangeSet, readRevisionDiff } = vi.hoisted(() => ({
  readChangeSet: vi.fn(),
  readRevisionDiff: vi.fn(),
}));
vi.mock("../actions", () => ({
  readChangeSet,
  readRevisionDiff,
  reviseTriage: vi.fn(),
  retryTriage: vi.fn(),
  saveBrief: vi.fn(),
  approveBrief: vi.fn(),
  saveAndApproveBrief: vi.fn(),
  sendWork: vi.fn(),
  cancelSend: vi.fn(),
  stopSend: vi.fn(),
  returnWork: vi.fn(),
  acceptWork: vi.fn(),
  refreshChecks: vi.fn(),
  closeItem: vi.fn(),
  reopenItem: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WorkItemPage } = await import("./work-item-page");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderRead(
  read: Read<WorkItemDetail>,
  options: {
    targets?: Read<WorkTargetList>;
    dialog?: "send" | null;
    changes?: Read<ChangeSet>;
  } = {},
) {
  const { source, calls, targetCalls, changeCalls } = workItemSource(
    read,
    options.targets,
    options.changes,
  );
  const element = await WorkItemPage({
    ctx,
    source,
    item: "WI-12",
    dialog: options.dialog ?? null,
  });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, targetCalls, changeCalls, ...view };
}

const renderDetail = (detail: WorkItemDetail) => renderRead(readOk(detail));

/** The head's actions, in the order the row draws them. */
function headActions(): string[] {
  return within(screen.getByTestId("work-item-head"))
    .queryAllByTestId(/^work-action-/)
    .map((element) => (element.getAttribute("data-testid") ?? "").replace("work-action-", ""));
}

/** The head's action buttons that carry the primary style. */
function primaries(): string[] {
  return within(screen.getByTestId("work-item-head"))
    .queryAllByTestId(/^work-action-/)
    .filter((element) => element.getAttribute("data-tone") === "primary")
    .map((element) => (element.getAttribute("data-testid") ?? "").replace("work-action-", ""));
}

const statusWord = () =>
  screen.getByTestId("work-item-status").querySelector("[data-status]")?.getAttribute("data-status");

// `cleanup()` runs whether or not the axe check passes, so one violation is
// reported once rather than by every test after it.
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("WorkItemPage › reads", () => {
  it("reads the item the URL names and the agents that can take it", async () => {
    const { calls, targetCalls } = await renderDetail(readyItem());
    expect(calls).toEqual([[ctx, "WI-12"]]);
    expect(targetCalls).toEqual([[ctx]]);
  });

  it("names the page Work item and the item by its title, the one h1", async () => {
    await renderDetail(readyItem());
    expect(screen.getByText("Work item")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "Retry the export when the API answers 429" }),
    ).toBeInTheDocument();
  });

  it("answers an item the workspace does not hold with a 404", async () => {
    const { source } = workItemSource(readError("work_item_not_found", 404));
    await expect(
      WorkItemPage({ ctx, source, item: "WI-404", dialog: null }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("draws a refused read as access denied with the permission it needed", async () => {
    await renderRead({ ok: false, reason: "denied", permission: "run.read" });
    const denied = screen.getByTestId("work-item-denied");
    expect(within(denied).getByRole("heading", { name: "Access denied" })).toBeInTheDocument();
    expect(denied).toHaveTextContent("run.read");
    expect(screen.queryByTestId("work-item-head")).toBeNull();
  });

  it("draws a failed read as the error state with its code and Try again", async () => {
    await renderRead(readError("work_records_unavailable", 503));
    const error = screen.getByTestId("work-item-error");
    expect(error).toHaveTextContent("503 work_records_unavailable");
    expect(within(error).getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/acme/core-platform/work/WI-12",
    );
  });

  it("holds Send back with its reason when the agents could not be read", async () => {
    await renderRead(readOk(readyItem()), {
      targets: readError("work_records_unavailable", 503),
    });
    const send = screen.getByTestId("work-action-send");
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      "oxagen could not read which agents can take work. Reload the page to try again.",
    );
  });
});

describe("WorkItemPage › states", () => {
  const STATES: [string, () => WorkItemDetail, string, string[]][] = [
    ["triaging", triagingItem, "triaging", []],
    ["triage failed", triageFailedItem, "triage_failed", ["correct-triage", "retry-triage"]],
    ["triage draft brief", triageDraftItem, "brief_to_approve", ["edit-brief", "approve"]],
    ["draft brief", draftBriefItem, "brief_to_approve", ["edit-brief", "approve"]],
    ["needs info", needsInfoItem, "needs_info", []],
    ["possible duplicate", possibleDuplicateItem, "possible_duplicate", ["keep-separate", "confirm-duplicate"]],
    ["changed", changedItem, "changed", ["approve", "edit-brief"]],
    ["ready", readyItem, "ready", ["close", "send"]],
    ["send rejected", sendRejectedItem, "send_rejected", ["close", "send"]],
    ["waiting for claim", waitingItem, "waiting_for_claim", ["cancel"]],
    ["no answer", noAnswerItem, "no_answer", ["cancel"]],
    ["running", runningItem, "running", ["open-run", "stop"]],
    ["stopping", stoppingItem, "stopping", ["withdraw"]],
    ["in review passing", inReviewItem, "in_review", ["open-pr", "return", "accept"]],
    ["check failed", checkFailedItem, "in_review", ["open-pr", "return", "accept"]],
    ["check missing", checkMissingItem, "in_review", ["open-pr", "return", "accept"]],
    ["no required checks", noRequiredChecksItem, "in_review", ["open-pr", "return", "accept"]],
    ["stale evidence", staleEvidenceItem, "in_review", ["open-pr", "return", "accept"]],
    ["merged before review", mergedBeforeReviewItem, "in_review", ["open-pr", "return", "accept"]],
    ["closed without merging", closedWithoutMergingItem, "in_review", ["open-pr", "close", "return"]],
    ["cost unknown", costUnknownItem, "in_review", ["open-pr", "return", "accept"]],
    ["accepted", acceptedItem, "accepted", ["open-pr"]],
    ["done", doneItem, "done", ["reopen"]],
    ["closed duplicate", closedDuplicateItem, "closed", ["reopen"]],
  ];

  it.each(STATES)(
    "%s: the status word, the head's actions, and no verdict word",
    async (_name, build, status, actions) => {
      await renderDetail(build());
      expect(statusWord()).toBe(status);
      expect(headActions()).toEqual(actions);
      // One primary at most, and it is the last action.
      const primary = primaries();
      expect(primary.length).toBeLessThanOrEqual(1);
      if (primary.length === 1) expect(actions.at(-1)).toBe(primary[0]);
      const text = document.body.textContent;
      expect(text).not.toMatch(/\bHeld\b/);
      expect(text).not.toMatch(/\bProven\b/);
      expect(text).not.toMatch(/\$0\.00/);
    },
  );

  it("triaging: says triage is reading the item and offers nothing yet", async () => {
    await renderDetail(triagingItem());
    expect(screen.getByTestId("work-item-wait")).toHaveTextContent("Triage is reading it.");
    expect(screen.getByTestId("work-panel-triage")).toHaveTextContent("Triage is reading this item.");
    expect(screen.queryByTestId("work-panel-delivery")).toBeNull();
  });

  it("triage failed: names the failure and offers Set priority and Retry triage", async () => {
    await renderDetail(triageFailedItem());
    expect(screen.getByTestId("work-triage-failed")).toHaveTextContent(
      "Triage failed. The model's answer did not match triage/v1.",
    );
    expect(screen.getByTestId("work-action-correct-triage")).toHaveTextContent("Set priority");
    expect(screen.getByTestId("work-action-retry-triage")).toHaveTextContent("Retry triage");
  });

  it("triage draft brief: shows triage's criteria as a draft not yet saved", async () => {
    await renderDetail(triageDraftItem());
    const brief = screen.getByTestId("work-panel-brief");
    expect(within(brief).getByTestId("work-brief-state")).toHaveTextContent("Not saved");
    expect(within(brief).getByTestId("work-brief-triage-draft")).toHaveTextContent(
      "The export retries after a 429.",
    );
    expect(screen.getByTestId("work-action-approve")).toHaveTextContent("Approve brief");
  });

  it("needs info: shows triage's question and the answer form", async () => {
    await renderDetail(needsInfoItem());
    const question = screen.getByTestId("work-triage-question");
    expect(question).toHaveTextContent("Which export: the CSV one or the scheduled report?");
    expect(question).toHaveTextContent(
      "The answer is kept on this item. oxagen writes nothing back to GitHub.",
    );
    expect(within(question).getByTestId("work-action-record-answer")).toBeEnabled();
  });

  it("possible duplicate: links the other item and offers both decisions", async () => {
    await renderDetail(possibleDuplicateItem());
    const note = screen.getByTestId("work-triage-duplicate");
    expect(within(note).getByRole("link", { name: "WI-3" })).toHaveAttribute(
      "href",
      "/acme/core-platform/work/WI-3",
    );
    expect(screen.getByTestId("work-action-keep-separate")).toHaveTextContent("Keep the item separate");
  });

  it("changed: names the revision the approval records and reads the brief Out of date", async () => {
    await renderDetail(changedItem());
    expect(screen.getByTestId("work-action-approve")).toHaveTextContent("Approve revision 2");
    expect(screen.getByTestId("work-brief-state")).toHaveTextContent("Out of date");
    // What revision 1 read stays beside the current text.
    expect(screen.getByTestId("work-source-first")).toHaveTextContent(
      "The export fails when the API answers 429.",
    );
    expect(screen.getByTestId("work-source-description")).toHaveTextContent(
      "The export fails when the API answers 429 or 503.",
    );
  });

  it("ready: says the item is not sent yet and offers Send to an agent", async () => {
    await renderDetail(readyItem());
    expect(screen.getByTestId("work-delivery-none")).toHaveTextContent("Not sent yet.");
    expect(screen.getByTestId("work-action-send")).toHaveTextContent("Send to an agent");
    expect(screen.getByTestId("work-brief-state")).toHaveTextContent("Approved");
    expect(screen.getByTestId("work-panel-brief")).toHaveTextContent(
      "oxagen marks no criterion met. A person reads each claim and accepts or returns the work.",
    );
  });

  it("send rejected: shows the rejected send with the runtime's reason", async () => {
    await renderDetail(sendRejectedItem());
    const row = screen.getByTestId("work-send-1");
    expect(row).toHaveAttribute("data-delivery", "rejected");
    expect(row).toHaveTextContent("Rejected");
    expect(row).toHaveTextContent("Claude Code on that runner is signed out.");
  });

  it("waiting for claim: shows the live work order key and that a retry reuses it", async () => {
    await renderDetail(waitingItem());
    expect(screen.getByTestId("work-send-1")).toHaveTextContent("Waiting for claim");
    expect(screen.getByTestId("work-delivery-key")).toHaveTextContent("wi_12ab:r1:s1");
    expect(screen.getByTestId("work-panel-delivery")).toHaveTextContent("A retry reuses it");
    expect(screen.getByTestId("work-delivery-budget")).toHaveTextContent(
      "The gateway holds the agent's budget before each model call when its version sets a ceiling.",
    );
    expect(screen.getByTestId("work-panel-delivery")).toHaveTextContent(
      "The work item adds no authority.",
    );
    expect(screen.getByRole("link", { name: "mnd_4f2a9c" })).toHaveAttribute(
      "href",
      "/acme/core-platform/mandates/mnd_4f2a9c",
    );
  });

  it("no answer: reads No answer on the send", async () => {
    await renderDetail(noAnswerItem());
    expect(screen.getByTestId("work-send-1")).toHaveAttribute("data-delivery", "no_answer");
    expect(screen.getByTestId("work-send-1")).toHaveTextContent("No answer");
  });

  it("running: links the run and offers Stop the run", async () => {
    await renderDetail(runningItem());
    expect(screen.getByTestId("work-action-open-run")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/ses_01run",
    );
    expect(screen.getByTestId("work-action-stop")).toHaveTextContent("Stop the run");
    expect(screen.getByTestId("work-send-1")).toHaveTextContent("Claimed on");
  });

  it("stopping: offers Withdraw the send when no run was linked", async () => {
    await renderDetail(stoppingItem());
    expect(screen.getByTestId("work-send-1")).toHaveTextContent("Stopping");
    expect(screen.getByTestId("work-action-withdraw")).toHaveTextContent("Withdraw the send");
  });

  it("in review passing: Accept is open, and the panel shows the checks and the consequence", async () => {
    await renderDetail(inReviewItem());
    expect(screen.getByTestId("work-action-accept")).toBeEnabled();
    expect(screen.getByTestId("work-action-open-pr")).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/pull/641",
    );
    const review = screen.getByTestId("work-panel-review");
    expect(within(review).getByTestId("work-review-checks")).toHaveTextContent("Passing");
    expect(within(review).getByTestId("work-check-test")).toHaveAttribute("data-conclusion", "success");
    expect(within(review).getByTestId("work-review-optional")).toHaveTextContent(
      "Shown for reference. Acceptance ignores them.",
    );
    expect(within(review).getByTestId("work-review-consequence")).toHaveTextContent(
      "Accept records your acceptance of 3f9a2c1 and merges nothing. The item is done once the pull request merges. Return sends it back to the agent with your reason, as a new send.",
    );
    // The agent's claim sits beside its criterion, and an unclaimed one reads no claim.
    expect(screen.getByTestId("work-brief-claim-c1")).toHaveTextContent("Claimed");
    expect(screen.getByTestId("work-brief-claim-c2")).toHaveTextContent("no claim");
  });

  it("in review with two pull requests: lists each with its forge state and keeps the facts' head and gate", async () => {
    await renderDetail(twoPullsItem());
    const review = screen.getByTestId("work-panel-review");
    expect(within(review).getByText("Pull requests")).toBeInTheDocument();
    const rows = within(review).getAllByTestId("work-review-pull");
    expect(rows.map((row) => row.getAttribute("data-pull-request"))).toEqual(["642", "641"]);
    expect(rows[0]).toHaveTextContent("acme/platform#642");
    expect(rows[0]?.querySelector('[data-pull-state="draft"]')).toHaveTextContent("Draft");
    expect(within(rows[1]!).getByRole("link", { name: "acme/platform#641" })).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/pull/641",
    );
    expect(rows[1]?.querySelector('[data-pull-state="merged"]')).toHaveTextContent("Merged");
    expect(rows[1]).toHaveTextContent("Retry the export on 429");
    // The head, the merge row, and Accept still read the send's facts.
    expect(within(review).getByTestId("work-review-head")).toHaveTextContent("3f9a2c1");
    expect(within(review).getByTestId("work-review-merge")).toHaveTextContent("Open");
    expect(screen.getByTestId("work-action-accept")).toBeEnabled();
    await expectNoAxe(document.body);
  });

  it("forge pull request with no fact: lists it and says Accept waits for the record", async () => {
    await renderDetail(unrecordedPullItem());
    const review = screen.getByTestId("work-panel-review");
    expect(within(review).getAllByTestId("work-review-pull")).toHaveLength(1);
    expect(review).toHaveTextContent("Accept waits until the send's record names one of these pull requests.");
    expect(review).not.toHaveTextContent("The run opened no pull request.");
    expect(within(review).queryByTestId("work-review-head")).toBeNull();
    await expectNoAxe(document.body);
  });

  it("in review with another forge pull request: keeps the facts' one beside it", async () => {
    await renderDetail(otherPullItem());
    const review = screen.getByTestId("work-panel-review");
    expect(within(review).getByText("Pull requests")).toBeInTheDocument();
    expect(within(review).getByTestId("work-review-fact-pull")).toHaveTextContent("acme/platform#641");
    const [other] = within(review).getAllByTestId("work-review-pull");
    expect(other).toHaveTextContent("acme/platform#700");
    expect(other?.querySelector('[data-pull-state="closed"]')).toHaveTextContent("Closed");
  });

  it("in review with no forge row: shows the facts' pull request as before (negative)", async () => {
    await renderDetail(inReviewItem());
    const review = screen.getByTestId("work-panel-review");
    expect(within(review).queryByTestId("work-review-pulls")).toBeNull();
    expect(within(review).getByText("Pull request")).toBeInTheDocument();
    expect(within(review).getByRole("link", { name: "acme/platform#641" })).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/pull/641",
    );
  });

  it("check failed: Accept is disabled with the failing check as its reason", async () => {
    await renderDetail(checkFailedItem());
    const accept = screen.getByTestId("work-action-accept");
    expect(accept).toBeDisabled();
    expect(accept).toHaveAccessibleDescription(
      "Required check test did not pass on the head commit.",
    );
    expect(screen.getByTestId("work-check-test")).toHaveAttribute("data-conclusion", "failure");
  });

  it("check missing: Accept is disabled and the missing check reads Not reported", async () => {
    await renderDetail(checkMissingItem());
    expect(screen.getByTestId("work-action-accept")).toHaveAccessibleDescription(
      "Required check e2e has not reported on the head commit.",
    );
    expect(screen.getByTestId("work-check-e2e")).toHaveTextContent("Not reported");
  });

  it("no required checks: Accept rests on the ticks and names the head", async () => {
    await renderDetail(noRequiredChecksItem());
    expect(screen.getByTestId("work-action-accept")).toBeEnabled();
    expect(screen.getByTestId("work-panel-review")).toHaveTextContent(
      "The base branch requires no check. Accept rests on a person's ticks for each criterion and names 3f9a2c1.",
    );
  });

  it("stale evidence: warns with the earlier results and never opens the gate", async () => {
    await renderDetail(staleEvidenceItem());
    const stale = screen.getByTestId("work-stale-evidence");
    expect(stale).toHaveTextContent("Stale evidence.");
    expect(stale).toHaveTextContent("2d4f6a8");
    expect(stale).toHaveTextContent("3f9a2c1");
    expect(within(stale).getByTestId("work-check-test")).toHaveAttribute("data-conclusion", "success");
    expect(screen.getByTestId("work-action-accept")).toBeDisabled();
  });

  it("merged before review: warns that the item is done only once a person accepts it", async () => {
    await renderDetail(mergedBeforeReviewItem());
    expect(screen.getByTestId("work-merged-before-review")).toHaveTextContent(
      "Merged before review.",
    );
    expect(screen.getByTestId("work-review-merge")).toHaveTextContent("7c1e0b4");
    expect(screen.getByTestId("work-action-accept")).toBeEnabled();
  });

  it("closed without merging: offers no Accept", async () => {
    await renderDetail(closedWithoutMergingItem());
    expect(screen.getByTestId("work-closed-unmerged")).toHaveTextContent("Closed without merging.");
    expect(screen.queryByTestId("work-action-accept")).toBeNull();
    expect(screen.queryByTestId("work-review-consequence")).toBeNull();
  });

  it("cost unknown for one run: reads unknown, never $0.00, and says what the total covers", async () => {
    await renderDetail(costUnknownItem());
    const cost = screen.getByTestId("work-panel-cost");
    expect(within(cost).getByTestId("work-cost-ses_02run")).toHaveTextContent("unknown");
    expect(within(cost).getByTestId("work-cost-ses_02run")).toHaveTextContent(
      "The run reported no usage.",
    );
    expect(within(cost).getByTestId("work-cost-ses_01run")).toHaveTextContent("$1.24");
    expect(within(cost).getByTestId("work-cost-total")).toHaveTextContent(
      "Cost known for 1 of 2 runs.",
    );
    expect(within(cost).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "href",
      "/acme/billing",
    );
  });

  it("accepted: names the commit the acceptance was given on", async () => {
    await renderDetail(acceptedItem());
    expect(screen.getByTestId("work-acceptance")).toHaveTextContent(
      "Marcus Bell accepted 3f9a2c1",
    );
    expect(screen.getByTestId("work-item-wait")).toHaveTextContent(
      "Accepted by Marcus Bell on 3f9a2c1. Waiting for the merge.",
    );
  });

  it("done: names the accepted commit and offers Reopen the item", async () => {
    await renderDetail(doneItem());
    expect(screen.getByTestId("work-acceptance")).toHaveTextContent("3f9a2c1");
    expect(screen.getByTestId("work-action-reopen")).toHaveTextContent("Reopen the item");
  });

  it("closed duplicate: says how it closed and offers Reopen the item", async () => {
    await renderDetail(closedDuplicateItem());
    expect(screen.getByTestId("work-item-wait")).toHaveTextContent("Closed as a duplicate");
    expect(screen.getByTestId("work-action-reopen")).toBeEnabled();
  });

  it("history: lists every entry in time order, one sentence each", async () => {
    await renderDetail(readyItem());
    const entries = screen.getAllByTestId("work-history-entry");
    expect(entries.map((entry) => entry.getAttribute("data-kind"))).toEqual([
      "collected",
      "triage_recorded",
      "brief_approved",
    ]);
    expect(entries[2]).toHaveTextContent("Marcus Bell approved brief revision 1.");
  });
});

describe("WorkItemPage › a reopened item", () => {
  it("draws no review from the cycle before the reopen", async () => {
    // A done item reopened: its finished send stays in the delivery history,
    // and the item names no send of its own until the next one goes out.
    const done = doneItem();
    const draft = draftBriefItem();
    await renderDetail({ ...draft, sends: done.sends, item: { ...draft.item, send: null } });
    expect(screen.queryByTestId("work-panel-review")).toBeNull();
    expect(screen.queryByTestId("work-action-accept")).toBeNull();
    expect(statusWord()).toBe("brief_to_approve");
  });
});

describe("WorkItemPage › a viewer whose roles read work", () => {
  it("disables every action with its reason and shows one note", async () => {
    await renderDetail(viewerOnlyItem());
    expect(screen.getByTestId("work-viewer-note")).toHaveTextContent(
      "Your role in this workspace reads work. A workspace Owner or Member approves, sends, and accepts it.",
    );
    for (const name of ["close", "send"]) {
      const button = screen.getByTestId(`work-action-${name}`);
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(
        "Your role in this workspace reads work. A workspace Owner or Member can do this.",
      );
    }
    expect(screen.getByTestId("work-action-correct-triage")).toBeDisabled();
  });

  it("shows no note to a viewer who may act", async () => {
    await renderDetail(readyItem());
    expect(screen.queryByTestId("work-viewer-note")).toBeNull();
  });
});

describe("WorkItemPage › source text stays data", () => {
  it("renders the title, description, labels and requester as text, never as markup", async () => {
    const hostile = "<script>alert('x')</script><b>bold</b>";
    const detail = readyItem();
    await renderDetail({
      ...detail,
      item: workItem({
        title: `<img src=x onerror=alert(1)>`,
        description: hostile,
        requester: "<i>Mallory</i>",
      }),
    });
    const description = screen.getByTestId("work-source-description");
    expect(description.textContent).toBe(hostile);
    expect(description.children).toHaveLength(0);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
    expect(screen.getByTestId("work-item-requester")).toHaveTextContent(
      "Requested by <i>Mallory</i>",
    );
  });

  it("links a GitHub issue as the source and marks the source as data", async () => {
    await renderDetail(readyItem());
    expect(screen.getByTestId("work-item-source")).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/issues/612",
    );
    expect(screen.getByTestId("work-panel-source")).toHaveTextContent("Treated as data");
  });

});

describe("work-item.builders", () => {
  it("parses as the read contract in every state the builders draw", () => {
    for (const build of [
      triagingItem,
      triageFailedItem,
      triageDraftItem,
      draftBriefItem,
      needsInfoItem,
      possibleDuplicateItem,
      changedItem,
      readyItem,
      sendRejectedItem,
      waitingItem,
      noAnswerItem,
      runningItem,
      stoppingItem,
      inReviewItem,
      checkFailedItem,
      checkMissingItem,
      noRequiredChecksItem,
      staleEvidenceItem,
      mergedBeforeReviewItem,
      closedWithoutMergingItem,
      costUnknownItem,
      acceptedItem,
      doneItem,
      closedDuplicateItem,
      viewerOnlyItem,
    ]) {
      expect(() => WorkItemDetail.parse(build())).not.toThrow();
    }
    expect(() => WorkTargetList.parse(workTargets())).not.toThrow();
  });
});

// ADR-292: the item's change set, and one per send, from the pull request store.
describe("WorkItemPage › changes", () => {
  it("reads the item's change set by its public id and draws its pull requests", async () => {
    const { changeCalls } = await renderRead(readOk(runningItem()), {
      changes: readOk(changeSet({ scope: "work_item" })),
    });
    expect(changeCalls).toEqual([[ctx, "work_item", "wi_12ab"]]);
    const panel = within(screen.getByTestId("work-panel-changes"));
    expect(panel.getByRole("heading", { level: 2, name: "Changes" })).toBeInTheDocument();
    expect(
      panel.getByRole("heading", { level: 3, name: "Pull requests" }),
    ).toBeInTheDocument();
    expect(panel.getAllByTestId("change-pull")).toHaveLength(2);
    expect(panel.getAllByTestId("change-file")).toHaveLength(2);
  });

  it("opens each send's change set by its work order, read once when it opens", async () => {
    const user = userEvent.setup();
    readChangeSet.mockReset();
    readChangeSet.mockResolvedValue({
      ok: true,
      value: changeSet({ scope: "work_order" }),
    });
    await renderRead(readOk(runningItem()));
    const sends = within(screen.getByTestId("work-changes-sends"));
    const toggle = sends.getByRole("button", { name: "Changes from send 1" });
    expect(readChangeSet).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(readChangeSet).toHaveBeenCalledExactlyOnceWith(
      "acme",
      "core-platform",
      "work_order",
      "wo_1a",
    );
    const set = within(await sends.findByTestId("change-set"));
    expect(set.getAllByTestId("change-pull")).toHaveLength(2);
  });

  it("reads an opened file's diff through the lane's action, once per pull request", async () => {
    const user = userEvent.setup();
    readRevisionDiff.mockReset();
    readRevisionDiff.mockImplementation(
      (_org: string, _ws: string, revisionId: string, paths: string[]) =>
        Promise.resolve({
          ok: true,
          value: revisionDiff(revisionId, paths[0] ?? "", "@@ -1,1 +1,1 @@\n-old\n+new"),
        }),
    );
    await renderRead(readOk(runningItem()), {
      changes: readOk(changeSet({ scope: "work_item" })),
    });
    const panel = within(screen.getByTestId("work-panel-changes"));
    await user.click(panel.getByRole("button", { name: /src\/app\.ts/ }));
    expect(readRevisionDiff.mock.calls).toEqual([
      ["acme", "core-platform", "prv_482a", ["src/app.ts"]],
      ["acme", "core-platform", "prv_490a", ["src/app.ts"]],
    ]);
    await waitFor(() => {
      expect(panel.getAllByText("+new")).toHaveLength(2);
    });
  });

  it("says the item has no pull request on record and lists no sends before the first send", async () => {
    await renderDetail(readyItem());
    const panel = within(screen.getByTestId("work-panel-changes"));
    expect(panel.getByTestId("change-set-empty")).toHaveTextContent(
      "No pull request is on record yet.",
    );
    expect(panel.queryByTestId("work-changes-sends")).toBeNull();
  });

  it("names a failed change set read in its panel and keeps the page (negative)", async () => {
    await renderRead(readOk(runningItem()), {
      changes: readError("work_records_unavailable", 503),
    });
    expect(screen.getByTestId("work-panel-changes")).toHaveTextContent(
      "work_records_unavailable",
    );
    expect(screen.getByTestId("work-panel-delivery")).toBeInTheDocument();
  });
});
