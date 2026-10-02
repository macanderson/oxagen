// @vitest-environment jsdom
// The Work item page's writes: each dialog and in-place action calls its
// server action with what the page read, reads the item again when it is
// done, and names a refusal in words a person can act on. The Send dialog
// offers the agents that can take the item, folds the others with their
// reasons, and passes the work order's key unchanged. The Accept dialog keeps
// Accept disabled until every criterion is ticked, and reads "Accept is
// blocked." while the gate is closed. Escape closes a dialog and focus goes
// back to the button that opened it. Every rendered state runs axe (INV-26).
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemDetail, WorkSend, WorkTargetList } from "@/data/contracts/work";
import { type Read, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  changedItem,
  checkFailedItem,
  DIGEST,
  DRAFT_DIGEST,
  doneItem,
  draftBriefItem,
  HEAD,
  inReviewItem,
  NEXT_KEY,
  needsInfoItem,
  possibleDuplicateItem,
  readyItem,
  runningItem,
  stoppingItem,
  triageDraftItem,
  triageFailedItem,
  waitingItem,
  workItemSource,
} from "./work-item.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { router, actions } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  actions: {
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
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../actions", () => actions);
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WorkItemPage } = await import("./work-item-page");
const { AcceptDialog } = await import("./review-dialogs");
const { itemData } = await import("./view");

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

const AFTER = { id: "wi_12ab", state: "ready", revision: 1, version: 5 };
const OK = { ok: true, value: { item: AFTER } };
const STALE = { ok: false, reason: "conflict", code: "stale_version" };
const STALE_TEXT = "This item changed since you opened it. Reload the page and try again.";

async function renderItem(
  detail: WorkItemDetail,
  options: { targets?: Read<WorkTargetList>; dialog?: "send" | null } = {},
) {
  const { source } = workItemSource(readOk(detail), options.targets);
  const element = await WorkItemPage({
    ctx,
    source,
    item: detail.item.number,
    dialog: options.dialog ?? null,
  });
  render(<IntlProvider>{element}</IntlProvider>);
  // `delay: null` keeps each interaction synchronous; the default wraps each
  // in a timer, which under the coverage run costs more than a case allows.
  return userEvent.setup({ delay: null });
}

function firstSend(detail: WorkItemDetail): WorkSend {
  const send = detail.sends[0];
  if (send === undefined) throw new Error("the fixture has no send");
  return send;
}

const dialog = (name: string) => screen.findByTestId(`work-dialog-${name}`);
const submit = (name: string) => screen.getByTestId(`work-dialog-${name}-submit`);

/** What each action answers when a test does not say otherwise: the write succeeded. */
beforeEach(() => {
  for (const action of Object.values(actions)) action.mockResolvedValue(OK);
  actions.reviseTriage.mockResolvedValue({ ok: true, value: { version: 5 } });
  actions.retryTriage.mockResolvedValue({ ok: true, value: { queued: true } });
  actions.saveBrief.mockResolvedValue({
    ok: true,
    value: { item: AFTER, brief: { revision: 2, digest: DRAFT_DIGEST } },
  });
  actions.sendWork.mockResolvedValue({
    ok: true,
    value: { item: AFTER, orderId: "wo_2b", repeat: false },
  });
  actions.returnWork.mockResolvedValue({
    ok: true,
    value: { item: AFTER, resent: true, resendRefused: null },
  });
  actions.acceptWork.mockResolvedValue({
    ok: true,
    value: { item: AFTER, requiredChecks: ["test", "typecheck"] },
  });
  actions.refreshChecks.mockResolvedValue({
    ok: true,
    value: { requiredChecks: ["test", "typecheck"], unreadReason: null },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Send dialog", () => {
  it("offers the agents that can take the item and folds the others with their reasons", async () => {
    const user = await renderItem(readyItem());
    await user.click(screen.getByTestId("work-action-send"));
    const send = await dialog("send");
    expect(within(send).getByTestId("work-send-agent-agt_stella")).toBeChecked();
    expect(within(send).getByTestId("work-send-agent-agt_claude")).not.toBeChecked();
    expect(within(send).queryByTestId("work-send-agent-agt_codex")).toBeNull();
    // A quiet host shows its last poll.
    expect(send).toHaveTextContent("ci-runner-6 last polled on");
    const folded = within(send).getByTestId("work-send-unavailable");
    expect(folded).toHaveTextContent("3 agents cannot take it now");
    expect(within(folded).getByTestId("work-send-out-agt_codex")).toHaveTextContent(
      "It has no runtime that can start a run.",
    );
    expect(within(folded).getByTestId("work-send-out-agt_cursor")).toHaveTextContent(
      "Update oxagen on that machine.",
    );
    expect(within(folded).getByTestId("work-send-out-agt_busy")).toHaveTextContent(
      "It is working on WI-7.",
    );
    // What the agent gets, and who starts the run.
    expect(send).toHaveTextContent("Revision 1");
    expect(send).toHaveTextContent("ab12ab12ab12");
    expect(send).toHaveTextContent(NEXT_KEY);
    expect(send).toHaveTextContent("Stella starts once Build box claims the send.");
  });

  it("sends with the key exactly as the item read it, then reads the item again", async () => {
    const user = await renderItem(readyItem());
    await user.click(screen.getByTestId("work-action-send"));
    const send = await dialog("send");
    await user.click(within(send).getByTestId("work-send-agent-agt_claude"));
    expect(send).toHaveTextContent("oxagen records spend after the run. Nothing stops the run at a limit.");
    await user.click(submit("send"));
    expect(actions.sendWork).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      itemRevision: 1,
      briefRevision: 1,
      briefDigest: DIGEST,
      agentId: "agt_claude",
      key: NEXT_KEY,
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByTestId("work-dialog-send")).toBeNull();
    });
  });

  it("opens on arrival when the URL asks for it", async () => {
    await renderItem(readyItem(), { dialog: "send" });
    expect(await dialog("send")).toBeInTheDocument();
  });

  it("stays closed on arrival when the item cannot be sent", async () => {
    await renderItem(runningItem(), { dialog: "send" });
    expect(screen.queryByTestId("work-dialog-send")).toBeNull();
  });

  it("names a refusal and reads the item again", async () => {
    actions.sendWork.mockResolvedValue(STALE);
    const user = await renderItem(readyItem());
    await user.click(screen.getByTestId("work-action-send"));
    await dialog("send");
    await user.click(submit("send"));
    expect(await screen.findByTestId("work-action-failure")).toHaveTextContent(STALE_TEXT);
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("Accept dialog", () => {
  it("keeps Accept disabled until every criterion is ticked, then accepts the head commit", async () => {
    const user = await renderItem(inReviewItem());
    await user.click(screen.getByTestId("work-action-accept"));
    const accept = await dialog("accept");
    expect(accept).toHaveTextContent("Tick each criterion you checked yourself on 3f9a2c1.");
    expect(accept).toHaveTextContent("Agent's claim: Added a backoff that reads Retry-After.");
    expect(accept).toHaveTextContent("No claim from the agent.");
    expect(accept).toHaveTextContent("Accepting merges nothing.");
    expect(submit("accept")).toBeDisabled();
    await user.click(within(accept).getByTestId("work-accept-c1"));
    expect(submit("accept")).toBeDisabled();
    await user.click(within(accept).getByTestId("work-accept-c2"));
    expect(submit("accept")).toBeEnabled();
    await user.click(submit("accept"));
    expect(actions.acceptWork).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      orderId: "wo_1a",
      headSha: HEAD,
      briefDigest: DIGEST,
      criteria: ["c1", "c2"],
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("reads Accept is blocked with the gate's reason while the gate is closed", async () => {
    const detail = checkFailedItem();
    render(
      <IntlProvider>
        <AcceptDialog
          org="acme"
          ws="core-platform"
          detail={itemData(detail)}
          send={firstSend(detail)}
          open
          onOpenChange={vi.fn()}
          onDone={vi.fn()}
        />
      </IntlProvider>,
    );
    const blocked = await screen.findByTestId("work-accept-blocked");
    expect(blocked).toHaveTextContent(
      "Accept is blocked. Required check test did not pass on the head commit.",
    );
    expect(screen.queryByTestId("work-dialog-accept-submit")).toBeNull();
    expect(screen.queryByTestId("work-accept-c1")).toBeNull();
  });
});

describe("Escape and focus", () => {
  it("closes a dialog on Escape and gives focus back to the button that opened it", async () => {
    const user = await renderItem(readyItem());
    const close = screen.getByTestId("work-action-close");
    await user.click(close);
    const opened = await dialog("close");
    await waitFor(() => {
      expect(opened.contains(document.activeElement)).toBe(true);
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("work-dialog-close")).toBeNull();
    });
    await waitFor(() => {
      expect(close).toHaveFocus();
    });
    expect(actions.closeItem).not.toHaveBeenCalled();
  });

  it("drops ?dialog=send when the dialog the URL opened closes", async () => {
    const user = await renderItem(readyItem(), { dialog: "send" });
    const send = await dialog("send");
    await user.click(within(send).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme/core-platform/work/WI-12", {
        scroll: false,
      });
    });
  });
});

describe("Triage decisions", () => {
  it("retries triage in place and reads the item again", async () => {
    const user = await renderItem(triageFailedItem());
    await user.click(screen.getByTestId("work-action-retry-triage"));
    expect(actions.retryTriage).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("sets the priority after triage failed, with the person's reason", async () => {
    const user = await renderItem(triageFailedItem());
    await user.click(screen.getByTestId("work-action-correct-triage"));
    const correct = await dialog("correct-triage");
    expect(within(correct).getByRole("heading", { name: "Set priority" })).toBeInTheDocument();
    await user.selectOptions(within(correct).getByLabelText("Priority"), "P1");
    await user.type(within(correct).getByLabelText("Reason"), "Customers hit this daily.");
    await user.click(submit("correct-triage"));
    expect(actions.reviseTriage).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      reason: "Customers hit this daily.",
      priority: "P1",
    });
  });

  it("corrects triage from the panel, sending only what changed", async () => {
    const user = await renderItem(readyItem());
    await user.click(screen.getByTestId("work-action-correct-triage"));
    const correct = await dialog("correct-triage");
    const labels = within(correct).getByLabelText("Labels");
    await user.clear(labels);
    await user.type(labels, "Bug, Export");
    await user.type(within(correct).getByLabelText("Reason"), "It is the export.");
    await user.click(submit("correct-triage"));
    expect(actions.reviseTriage).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      reason: "It is the export.",
      labels: ["Bug", "Export"],
    });
  });

  it("records an answer to triage's question as the outcome triaged", async () => {
    const user = await renderItem(needsInfoItem());
    await user.type(screen.getByLabelText("Answer"), "The CSV export.");
    await user.click(screen.getByTestId("work-action-record-answer"));
    expect(actions.reviseTriage).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      reason: "The CSV export.",
      outcome: "triaged",
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("keeps a possible duplicate separate with the person's reason", async () => {
    const user = await renderItem(possibleDuplicateItem());
    await user.click(screen.getByTestId("work-action-keep-separate"));
    const keep = await dialog("keep-separate");
    await user.type(within(keep).getByLabelText("Reason"), "WI-3 is the PDF export.");
    await user.click(submit("keep-separate"));
    expect(actions.reviseTriage).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      reason: "WI-3 is the PDF export.",
      outcome: "triaged",
    });
  });

  it("confirms a duplicate by closing the item as a duplicate of the other one", async () => {
    const user = await renderItem(possibleDuplicateItem());
    await user.click(screen.getByTestId("work-action-confirm-duplicate"));
    const close = await dialog("close");
    expect(within(close).getByTestId("work-close-duplicate")).toBeChecked();
    expect(within(close).getByLabelText("Reason")).toHaveValue("Duplicate of WI-3.");
    expect(close).toHaveTextContent("The GitHub issue stays open, because oxagen writes nothing back.");
    await user.click(submit("close"));
    expect(actions.closeItem).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      resolution: "duplicate",
      reason: "Duplicate of WI-3.",
    });
  });
});

describe("Brief decisions", () => {
  it("approves triage's draft by saving it for the item's revision first", async () => {
    const user = await renderItem(triageDraftItem());
    await user.click(screen.getByTestId("work-action-approve"));
    expect(actions.saveAndApproveBrief).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      itemRevision: 1,
      repository: "acme/platform",
      criteria: [
        {
          criterion: null,
          text: "The export retries after a 429.",
          tag: "code",
          intent: "review",
          evidence: "",
          provenance: "triage",
        },
        {
          criterion: null,
          text: "A test covers the retry.",
          tag: "code",
          intent: "review",
          evidence: "",
          provenance: "triage",
        },
      ],
    });
  });

  it("approves a draft saved for the item's revision with its revision and digest", async () => {
    const user = await renderItem(draftBriefItem());
    await user.click(screen.getByTestId("work-action-approve"));
    expect(actions.approveBrief).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      itemRevision: 1,
      briefRevision: 1,
      briefDigest: DRAFT_DIGEST,
    });
    expect(actions.saveAndApproveBrief).not.toHaveBeenCalled();
  });

  it("approves the next revision after the source changed, keeping each criterion's key", async () => {
    const user = await renderItem(changedItem());
    await user.click(screen.getByTestId("work-action-approve"));
    expect(actions.saveAndApproveBrief).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({
        itemId: "wi_12ab",
        version: 6,
        itemRevision: 2,
        repository: "acme/platform",
        criteria: [
          expect.objectContaining({ criterion: "c1" }),
          expect.objectContaining({ criterion: "c2" }),
        ],
      }),
    );
  });

  it("names a refused approval and reads the item again", async () => {
    actions.approveBrief.mockResolvedValue(STALE);
    const user = await renderItem(draftBriefItem());
    await user.click(screen.getByTestId("work-action-approve"));
    expect(await screen.findByTestId("work-action-failure")).toHaveTextContent(STALE_TEXT);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("saves an edited brief as a draft, each criterion keeping its key", async () => {
    const user = await renderItem(draftBriefItem());
    await user.click(screen.getByTestId("work-action-edit-brief"));
    const edit = await dialog("edit-brief");
    expect(within(edit).getByLabelText("Repository")).toHaveValue("acme/platform");
    expect(within(edit).getAllByTestId("work-brief-criterion")).toHaveLength(2);
    await user.click(within(edit).getByTestId("work-brief-add"));
    await user.type(within(edit).getByLabelText("Criterion 3"), "The docs name the retry.");
    await user.click(submit("edit-brief"));
    expect(actions.saveBrief).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      itemRevision: 1,
      repository: "acme/platform",
      criteria: [
        expect.objectContaining({ criterion: "c1" }),
        expect.objectContaining({ criterion: "c2" }),
        {
          criterion: null,
          text: "The docs name the retry.",
          tag: "code",
          intent: "review",
          evidence: "",
          provenance: "person",
        },
      ],
    });
  });
});

describe("Ending a send", () => {
  it("cancels a send no runtime claimed", async () => {
    const user = await renderItem(waitingItem());
    await user.click(screen.getByTestId("work-action-cancel"));
    const stop = await dialog("stop");
    expect(within(stop).getByRole("heading", { name: "Cancel the send" })).toBeInTheDocument();
    await user.type(within(stop).getByLabelText("Reason"), "Wrong repository.");
    await user.click(submit("stop"));
    expect(actions.cancelSend).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      orderId: "wo_1a",
      reason: "Wrong repository.",
    });
    expect(actions.stopSend).not.toHaveBeenCalled();
  });

  it("asks the runtime to stop a claimed run", async () => {
    const user = await renderItem(runningItem());
    await user.click(screen.getByTestId("work-action-stop"));
    const stop = await dialog("stop");
    expect(stop).toHaveTextContent("The page shows the run stopped once Build box confirms.");
    await user.type(within(stop).getByLabelText("Reason"), "Wrong repository.");
    await user.click(submit("stop"));
    expect(actions.stopSend).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      orderId: "wo_1a",
      reason: "Wrong repository.",
    });
  });

  it("withdraws a stopping send that never linked a run", async () => {
    const user = await renderItem(stoppingItem());
    await user.click(screen.getByTestId("work-action-withdraw"));
    const stop = await dialog("stop");
    await user.type(within(stop).getByLabelText("Reason"), "The runtime is gone.");
    await user.click(submit("stop"));
    expect(actions.cancelSend).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      orderId: "wo_1a",
      reason: "The runtime is gone.",
    });
  });
});

describe("Review decisions", () => {
  it("returns the work with a new send by default", async () => {
    const user = await renderItem(inReviewItem());
    await user.click(screen.getByTestId("work-action-return"));
    const back = await dialog("return");
    expect(within(back).getByTestId("work-return-resend")).toBeChecked();
    await user.type(within(back).getByLabelText("Reason"), "The 429 still has no Retry-After.");
    await user.click(submit("return"));
    expect(actions.returnWork).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      orderId: "wo_1a",
      reason: "The 429 still has no Retry-After.",
      resend: true,
    });
  });

  it("says why no new send went out when the resend was refused", async () => {
    actions.returnWork.mockResolvedValue({
      ok: true,
      value: { item: AFTER, resent: false, resendRefused: "Stella is working on WI-7." },
    });
    const user = await renderItem(inReviewItem());
    await user.click(screen.getByTestId("work-action-return"));
    const back = await dialog("return");
    await user.click(within(back).getByTestId("work-return-resend"));
    await user.type(within(back).getByLabelText("Reason"), "Not yet.");
    await user.click(submit("return"));
    expect(actions.returnWork).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({ resend: false }),
    );
    expect(await screen.findByTestId("work-action-notice")).toHaveTextContent(
      "The return stands, and oxagen did not send the item again. Stella is working on WI-7. The item waits in Ready.",
    );
  });

  it("reads the checks again and says when GitHub could not be read", async () => {
    actions.refreshChecks.mockResolvedValue({
      ok: true,
      value: { requiredChecks: null, unreadReason: "GitHub answered 502." },
    });
    const user = await renderItem(inReviewItem());
    await user.click(screen.getByTestId("work-action-refresh-checks"));
    expect(actions.refreshChecks).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      orderId: "wo_1a",
    });
    expect(await screen.findByTestId("work-checks-unread")).toHaveTextContent(
      "GitHub could not be read. GitHub answered 502.",
    );
  });
});

describe("Close and reopen", () => {
  it("closes a ready item with a resolution and a reason", async () => {
    const user = await renderItem(readyItem());
    await user.click(screen.getByTestId("work-action-close"));
    const close = await dialog("close");
    expect(within(close).getByTestId("work-close-cancelled")).toBeChecked();
    await user.click(within(close).getByTestId("work-close-declined"));
    await user.type(within(close).getByLabelText("Reason"), "We will not support 429 retries.");
    await user.click(submit("close"));
    expect(actions.closeItem).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      resolution: "declined",
      reason: "We will not support 429 retries.",
    });
  });

  it("reopens a done item and says the history stays", async () => {
    const user = await renderItem(doneItem());
    await user.click(screen.getByTestId("work-action-reopen"));
    const reopen = await dialog("reopen");
    expect(reopen).toHaveTextContent(
      "The earlier sends, review, and result stay in the history. The brief goes back to a draft",
    );
    await user.type(within(reopen).getByLabelText("Reason"), "The fix regressed.");
    await user.click(submit("reopen"));
    expect(actions.reopenItem).toHaveBeenCalledWith("acme", "core-platform", {
      itemId: "wi_12ab",
      version: 4,
      reason: "The fix regressed.",
    });
  });
});
