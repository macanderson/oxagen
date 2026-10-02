// @vitest-environment jsdom
// The steering PR writes as a person makes them: each write sends the
// proposal the page shows, a completed write reloads the view it leads to, a
// refusal is named where the person acted and navigates nowhere, and a merge
// the checks have not cleared cannot be sent. A revert waits for its dialog's
// confirmation and links the pull request it opened in place. Every refusal code the handlers
// and the merge queue throw has its own sentence, and a write the platform has
// not registered says so. Each state gets an axe check.
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const {
  router,
  openContextPr,
  mergeContextPr,
  dismissProposal,
  approveContextPr,
  mergePrWithoutReview,
  restoreManagedBlock,
  revertSteeringPr,
} = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  openContextPr: vi.fn(),
  mergeContextPr: vi.fn(),
  dismissProposal: vi.fn(),
  approveContextPr: vi.fn(),
  mergePrWithoutReview: vi.fn(),
  restoreManagedBlock: vi.fn(),
  revertSteeringPr: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  openContextPr,
  mergeContextPr,
  dismissProposal,
  approveContextPr,
  mergePrWithoutReview,
  restoreManagedBlock,
  revertSteeringPr,
  dropMemoryRecord: vi.fn(),
}));

const {
  ApproveContextPr,
  MergeContextPr,
  MergeWithoutReview,
  ProposalWrites,
  RestoreManagedBlock,
  RevertSteeringPr,
} = await import("./write-controls");
const { useActionFailure } = await import("./action-failure");

const TARGET = { org: "acme", ws: "core-platform", proposalId: "prp_01k5ru4a" };
const PRS = "/acme/core-platform/steering/proposals/prs?proposal=prp_01k5ru4a";

const intl = ({ children }: { children: ReactNode }) => (
  <IntlProvider>{children}</IntlProvider>
);

beforeEach(() => {
  for (const fn of [
    router.replace,
    router.refresh,
    openContextPr,
    mergeContextPr,
    dismissProposal,
    approveContextPr,
    mergePrWithoutReview,
    restoreManagedBlock,
    revertSteeringPr,
  ]) {
    fn.mockReset();
  }
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Open a Context PR", () => {
  function openDialog(label = "Open a Context PR") {
    render(<ProposalWrites {...TARGET} status="proposed" />, { wrapper: intl });
    fireEvent.click(screen.getByRole("button", { name: label }));
    return screen.getByTestId("open-context-pr");
  }

  it("opens the pull request for this proposal and reloads its Context PR", async () => {
    openContextPr.mockResolvedValue({
      ok: true,
      value: { status: "checks_passed" },
    });
    openDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PRS);
    });
    expect(openContextPr).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
    );
    expect(router.refresh).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByTestId("open-context-pr")).toBeNull();
    });
  });

  it("names a refusal in the dialog and navigates nowhere (negative)", async () => {
    openContextPr.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    });
    openDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    expect(
      await screen.findByTestId("open-context-pr-failure"),
    ).toHaveTextContent(
      "Another pull request is already open for this lineage. Merge or close it first.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a write that threw before it answered (negative)", async () => {
    openContextPr.mockRejectedValue(new Error("network"));
    openDialog();
    fireEvent.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    expect(
      await screen.findByTestId("open-context-pr-failure"),
    ).toHaveTextContent(
      "The change could not be made: action_failed. Nothing was changed.",
    );
  });

  it("offers to run the checks again once the pull request exists", async () => {
    openContextPr.mockResolvedValue({
      ok: true,
      value: { status: "checks_failed" },
    });
    render(<ProposalWrites {...TARGET} status="checks_failed" />, {
      wrapper: intl,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Run the checks again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run the checks" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PRS);
    });
  });

  it("still offers the re-run once the checks have passed, because the head can move under them", async () => {
    openContextPr.mockResolvedValue({
      ok: true,
      value: { status: "checks_running" },
    });
    render(<ProposalWrites {...TARGET} status="checks_passed" />, {
      wrapper: intl,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Run the checks again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run the checks" }));
    await waitFor(() => {
      expect(openContextPr).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "prp_01k5ru4a",
      );
    });
  });

  it("offers no write on a merged proposal (negative)", () => {
    render(<ProposalWrites {...TARGET} status="merged" />, { wrapper: intl });
    expect(
      screen.queryByRole("button", { name: "Run the checks again" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("Dismiss", () => {
  function submitReason(reason: string) {
    render(<ProposalWrites {...TARGET} status="checks_failed" />, {
      wrapper: intl,
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), {
      target: { value: reason },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss the proposal" }),
    );
  }

  it("dismisses this proposal with the reason written and reloads Proposals", async () => {
    dismissProposal.mockResolvedValue({
      ok: true,
      value: { status: "rejected" },
    });
    submitReason("Duplicate of ctx.release.notes-format");
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/acme/core-platform/steering/proposals",
      );
    });
    expect(dismissProposal).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
      "Duplicate of ctx.release.notes-format",
    );
  });

  it("names a role refusal and changes nothing (negative)", async () => {
    dismissProposal.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    submitReason("Not worth the tokens");
    expect(
      await screen.findByTestId("dismiss-proposal-failure"),
    ).toHaveTextContent(
      "Your role in this organization or workspace does not allow this change. Nothing was changed.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("Merge pull request", () => {
  it("cannot be sent while the checks have not passed (negative)", () => {
    render(<MergeContextPr {...TARGET} blocked />, { wrapper: intl });
    const button = screen.getByRole("button", { name: "Merge pull request" });
    expect(button).toBeDisabled();
    const form = button.closest("form");
    if (form === null) throw new Error("the merge button sits in no form");
    fireEvent.submit(form);
    expect(mergeContextPr).not.toHaveBeenCalled();
    expect(
      screen.getByText("Merge is blocked until every check passes."),
    ).toBeInTheDocument();
  });

  it("merges this proposal's pull request and reloads its Context PR", async () => {
    mergeContextPr.mockResolvedValue({
      ok: true,
      value: { commit: "4d5e6f7" },
    });
    render(<MergeContextPr {...TARGET} blocked={false} />, { wrapper: intl });
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PRS);
    });
    expect(mergeContextPr).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
    );
  });

  it("names a separation-of-duties refusal beside the button (negative)", async () => {
    mergeContextPr.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "separation_of_duties",
    });
    render(<MergeContextPr {...TARGET} blocked={false} />, { wrapper: intl });
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    expect(
      await screen.findByTestId("merge-context-pr-failure"),
    ).toHaveTextContent(
      "Under this governance mode the author does not merge their own proposal. Another reviewer merges it.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("Approve", () => {
  it("approves this proposal's pull request and reloads its steering PR", async () => {
    approveContextPr.mockResolvedValue({ ok: true, value: { approvals: 1 } });
    render(<ApproveContextPr {...TARGET} />, { wrapper: intl });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PRS);
    });
    expect(approveContextPr).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
    );
  });

  it("says the platform has not registered approve yet (negative)", async () => {
    approveContextPr.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "tool_not_registered",
    });
    render(<ApproveContextPr {...TARGET} />, { wrapper: intl });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByTestId("approve-context-pr-failure"),
    ).toHaveTextContent("Oxagen has not registered this action yet.");
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("Merge without review", () => {
  it("cannot be sent while the checks have not passed (negative)", () => {
    render(<MergeWithoutReview {...TARGET} blocked />, { wrapper: intl });
    const button = screen.getByRole("button", { name: "Merge without review" });
    expect(button).toBeDisabled();
    const form = button.closest("form");
    if (form === null) throw new Error("the button sits in no form");
    fireEvent.submit(form);
    expect(mergePrWithoutReview).not.toHaveBeenCalled();
  });

  it("merges this proposal's pull request without an approval and reloads it", async () => {
    mergePrWithoutReview.mockResolvedValue({
      ok: true,
      value: { commit: "4d5e6f7" },
    });
    render(<MergeWithoutReview {...TARGET} blocked={false} />, {
      wrapper: intl,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Merge without review" }),
    );
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PRS);
    });
    expect(mergePrWithoutReview).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
    );
  });
});

describe("Restore block", () => {
  it("restores the managed block in the drifted file and reloads the steering PR", async () => {
    restoreManagedBlock.mockResolvedValue({
      ok: true,
      value: { commitSha: "a1b2c3d4e5f6" },
    });
    render(<RestoreManagedBlock {...TARGET} path="AGENTS.md" />, {
      wrapper: intl,
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore block" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(PRS);
    });
    expect(restoreManagedBlock).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
      "AGENTS.md",
    );
  });
});

describe("Revert pull request", () => {
  const REVERT_URL = "https://github.com/acme/core-platform/pull/520";

  function confirmRevert() {
    render(<RevertSteeringPr {...TARGET} />, { wrapper: intl });
    fireEvent.click(screen.getByRole("button", { name: "Revert pull request" }));
    const dialog = screen.getByTestId("revert-steering-pr");
    fireEvent.click(screen.getByRole("button", { name: "Open the revert" }));
    return dialog;
  }

  it("asks for confirmation first, and sends nothing until the person confirms", () => {
    render(<RevertSteeringPr {...TARGET} />, { wrapper: intl });
    expect(screen.queryByTestId("revert-steering-pr")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revert pull request" }));
    expect(screen.getByTestId("revert-steering-pr")).toHaveTextContent(
      "Nothing changes until the new pull request passes review and merges.",
    );
    expect(revertSteeringPr).not.toHaveBeenCalled();
  });

  it("opens the revert for this proposal and links the pull request in place", async () => {
    revertSteeringPr.mockResolvedValue({
      ok: true,
      value: {
        number: 520,
        url: REVERT_URL,
        branch: "steering/revert-519",
        check: "success",
      },
    });
    confirmRevert();
    expect(
      await screen.findByText("Revert pull request #520 is open."),
    ).toBeInTheDocument();
    expect(revertSteeringPr).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01k5ru4a",
    );
    expect(
      screen.getByRole("link", { name: "Go to pull request #520" }),
    ).toHaveAttribute("href", REVERT_URL);
    expect(screen.queryByTestId("revert-steering-pr")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Revert pull request" }),
    ).toBeNull();
    // The merged PR's panel does not change, so nothing reloads.
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("says when the Oxagen steering check failed on the revert", async () => {
    revertSteeringPr.mockResolvedValue({
      ok: true,
      value: {
        number: 520,
        url: REVERT_URL,
        branch: "steering/revert-519",
        check: "failure",
      },
    });
    confirmRevert();
    expect(
      await screen.findByText(
        "The Oxagen steering check failed on the revert. Read the check on the pull request.",
      ),
    ).toBeInTheDocument();
  });

  it("names a refusal in the dialog and opens nothing (negative)", async () => {
    revertSteeringPr.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    confirmRevert();
    expect(
      await screen.findByTestId("revert-steering-pr-failure"),
    ).toHaveTextContent(
      "Your role in this organization or workspace does not allow this change. Nothing was changed.",
    );
    expect(screen.queryByText(/is open\./)).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("the sentence for each refusal", () => {
  it.each([
    [
      { reason: "denied", code: "no_principal" },
      "This change needs a signed-in person. Nothing was changed.",
    ],
    [
      { reason: "not_found", code: "proposal_not_found" },
      "This proposal is not in this workspace.",
    ],
    [
      { reason: "conflict", code: "governance_unreadable" },
      "could not be read, so nothing was opened or merged.",
    ],
    [
      { reason: "not_found", code: "workspace_repository_missing" },
      "This workspace has no connected repository",
    ],
    [
      { reason: "conflict", code: "checks_not_passed" },
      "Merge is blocked until every check passes.",
    ],
    [
      { reason: "conflict", code: "head_moved" },
      "The pull request changed after the checks ran. Run the checks again.",
    ],
    [
      { reason: "conflict", code: "base_moved" },
      "no longer targets the production branch",
    ],
    [
      { reason: "conflict", code: "github_refused" },
      "GitHub refused the change. Nothing was published.",
    ],
    [
      { reason: "conflict", code: "merge_time_unknown" },
      "GitHub has not said when, so nothing was published. Merge again",
    ],
    [
      { reason: "conflict", code: "merged_outside_oxagen" },
      "Oxagen publishes what the production branch holds",
    ],
    [
      { reason: "conflict", code: "already_merged" },
      "This proposal changed after the page loaded.",
    ],
    [
      { reason: "conflict", code: "proposal_checks_running" },
      "This proposal changed after the page loaded.",
    ],
    [
      { reason: "conflict", code: "record_file_missing" },
      "The record file is not on the branch at the checked commit.",
    ],
    [
      { reason: "denied", code: "approval_required" },
      "needs an approval from a workspace member other than the author",
    ],
    [
      { reason: "conflict", code: "repository_unhealthy" },
      "Oxagen merges nothing until they are fixed.",
    ],
    [
      { reason: "conflict", code: "too_many_files" },
      "This steering PR changes too many files to merge.",
    ],
    [
      { reason: "conflict", code: "version_mismatch" },
      "is not the one in force. Run the checks again.",
    ],
    [
      { reason: "conflict", code: "production_branch_missing" },
      "The repository has no production branch to merge into.",
    ],
    [
      { reason: "conflict", code: "production_branch_moving" },
      "The production branch kept moving while Oxagen was merging. Merge again.",
    ],
    [
      { reason: "conflict", code: "checks_failed" },
      "the checks failed after Oxagen brought the branch up to date",
    ],
    [
      { reason: "conflict", code: "not_merged" },
      "Only a merged steering PR can be reverted. Nothing was opened.",
    ],
    [
      { reason: "conflict", code: "governance_proposal" },
      "Set the mode again to change it back.",
    ],
    [
      { reason: "conflict", code: "pr_not_recorded" },
      "This proposal has no recorded pull request.",
    ],
    [
      { reason: "conflict", code: "repository_changed" },
      "Revert it there by hand.",
    ],
    [
      { reason: "conflict", code: "merge_commit_unknown" },
      "Oxagen cannot find what the production branch held before this merge",
    ],
    [
      { reason: "conflict", code: "nothing_to_revert" },
      "This merge changed nothing outside the ledger",
    ],
    [
      { reason: "conflict", code: "revert_branch_exists" },
      "A revert of this pull request is already open",
    ],
    [
      { reason: "conflict", code: "some_new_reason" },
      "The change was refused: some_new_reason. Nothing was changed.",
    ],
    [
      { reason: "unavailable", code: "tool_not_registered" },
      "Oxagen has not registered this action yet.",
    ],
    [
      { reason: "invalid", code: "invalid_input", field: "reason" },
      "Write a reason before you dismiss the proposal.",
    ],
    [
      { reason: "pending_approval", accessRequestId: "acr_1" },
      "The change is waiting for approval: acr_1.",
    ],
    [
      { reason: "unavailable", code: "kernel_failure" },
      "The change could not be made: kernel_failure.",
    ],
  ] as const)("%j", (failure, text) => {
    const { result } = renderHook(() => useActionFailure(), { wrapper: intl });
    expect(result.current({ ok: false, ...failure })).toContain(text);
  });
});
