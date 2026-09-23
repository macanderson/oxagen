// @vitest-environment jsdom
// The Context PR writes as a person makes them: each write sends the proposal
// the page shows, a completed write reloads the view it leads to, a refusal
// is named where the person acted and navigates nowhere, and a merge the
// checks have not cleared cannot be sent. Every refusal code the three
// handlers throw has its own sentence. Each state gets an axe check.
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

const { router, openContextPr, mergeContextPr, dismissProposal } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    openContextPr: vi.fn(),
    mergeContextPr: vi.fn(),
    dismissProposal: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  openContextPr,
  mergeContextPr,
  dismissProposal,
}));

const { MergeContextPr, ProposalWrites } = await import("./write-controls");
const { useActionFailure } = await import("./action-failure");

const TARGET = { org: "acme", ws: "core-platform", proposalId: "prp_01k5ru4a" };
const PRS = "/acme/core-platform/steering?tab=prs&proposal=prp_01k5ru4a";

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
      "Another pull request is already open for this lineage. One concern, one pull request.",
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
      "This workspace has no connected GitHub repository",
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
      { reason: "conflict", code: "already_merged" },
      "This proposal changed after the page loaded.",
    ],
    [
      { reason: "conflict", code: "proposal_checks_running" },
      "This proposal changed after the page loaded.",
    ],
    [
      { reason: "conflict", code: "record_file_missing" },
      "The change was refused: record_file_missing. Nothing was changed.",
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
