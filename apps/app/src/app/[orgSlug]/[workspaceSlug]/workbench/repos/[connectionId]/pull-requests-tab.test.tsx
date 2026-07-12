// @vitest-environment jsdom
/**
 * pull-requests-tab.test.tsx — unit tests for PullRequestsTab.
 *
 * Covers: OpenPrForm hidden when canManage===false, PR-number lookup
 * validation, a successful lookup rendering the PR + diff, and the
 * CI_BADGE overall→variant mapping (passing/pending/failing/unknown).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PullRequestsTab } from "./pull-requests-tab";
import type { RepoPrGetOutput } from "@oxagen/oxagen/contracts/repo.pr.get";

const { getPrAction, getPrDiffAction, openPrAction, getCiStatusAction } = vi.hoisted(() => ({
  getPrAction: vi.fn(),
  getPrDiffAction: vi.fn(),
  openPrAction: vi.fn(),
  getCiStatusAction: vi.fn(),
}));

vi.mock("../actions", () => ({ getPrAction, getPrDiffAction, openPrAction, getCiStatusAction }));

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const SLUG = { owner: "acme", repo: "widgets" };

function makePr(overrides: Partial<RepoPrGetOutput> = {}): RepoPrGetOutput {
  return {
    number: 42,
    title: "Fix the thing",
    url: "https://github.com/acme/widgets/pull/42",
    state: "open",
    draft: false,
    author: "octocat",
    headRef: "fix-branch",
    baseRef: "main",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    ci: { overall: "passing", runs: [] },
    ...overrides,
  } as RepoPrGetOutput;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PullRequestsTab", () => {
  it("renders an empty state instead of forms when slug is null", () => {
    render(<PullRequestsTab scope={SCOPE} slug={null} canManage={true} defaultHead={null} />);
    expect(screen.queryByTestId("repo-pulls-tab")).not.toBeInTheDocument();
    expect(screen.getByText("Repo setup incomplete")).toBeInTheDocument();
  });

  it("hides the Open PR form for a non-manager", () => {
    render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={false} defaultHead={null} />);
    expect(screen.queryByTestId("open-pr-submit")).not.toBeInTheDocument();
    expect(screen.queryByText("Open a pull request")).not.toBeInTheDocument();
  });

  it("shows the Open PR form for a manager", () => {
    render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={true} defaultHead={null} />);
    expect(screen.getByTestId("open-pr-submit")).toBeInTheDocument();
  });

  it("rejects a non-numeric PR number without calling the action", async () => {
    const user = userEvent.setup();
    render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={true} defaultHead={null} />);

    await user.click(screen.getByTestId("pr-lookup-submit"));

    expect(await screen.findByText("Enter a valid PR number.")).toBeInTheDocument();
    expect(getPrAction).not.toHaveBeenCalled();
  });

  it("rejects a zero PR number without calling the action", async () => {
    // The <input type="number" min={1}> blocks a real click-submit for "0"
    // via native HTML5 constraint validation before it ever reaches React
    // (step/min mismatch — confirmed by input.validity.valid === false), so
    // the app-level `num <= 0` guard is reached the same way a genuinely
    // empty field is: dispatch the form's submit event directly, bypassing
    // the browser's interactive-validation gate rather than the (blocked)
    // submit-button click.
    const user = userEvent.setup();
    render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={true} defaultHead={null} />);

    const input = screen.getByTestId("pr-lookup-input");
    await user.type(input, "0");
    fireEvent.submit(input.closest("form")!);

    expect(await screen.findByText("Enter a valid PR number.")).toBeInTheDocument();
    expect(getPrAction).not.toHaveBeenCalled();
  });

  it("a successful lookup renders the PR and its diff", async () => {
    getPrAction.mockResolvedValue({ ok: true, result: makePr() });
    getPrDiffAction.mockResolvedValue({
      ok: true,
      result: {
        summary: "1 file changed",
        files: [{ path: "src/index.ts", status: "modified", patch: "+added line" }],
      },
    });
    const user = userEvent.setup();
    render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={true} defaultHead={null} />);

    await user.type(screen.getByTestId("pr-lookup-input"), "42");
    await user.click(screen.getByTestId("pr-lookup-submit"));

    const result = await screen.findByTestId("pr-lookup-result");
    expect(result).toHaveTextContent("#42 Fix the thing");
    expect(result).toHaveTextContent("1 file changed");
    expect(getPrAction).toHaveBeenCalledWith(
      expect.objectContaining({ ...SCOPE, ...SLUG, number: 42 }),
    );
    expect(getPrDiffAction).toHaveBeenCalledWith(
      expect.objectContaining({ ...SCOPE, ...SLUG, number: 42 }),
    );
  });

  it("shows the lookup error and no result when getPrAction fails", async () => {
    getPrAction.mockResolvedValue({ ok: false, error: "Pull request not found" });
    getPrDiffAction.mockResolvedValue({ ok: true, result: { summary: "", files: [] } });
    const user = userEvent.setup();
    render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={true} defaultHead={null} />);

    await user.type(screen.getByTestId("pr-lookup-input"), "99");
    await user.click(screen.getByTestId("pr-lookup-submit"));

    expect(await screen.findByText("Pull request not found")).toBeInTheDocument();
    expect(screen.queryByTestId("pr-lookup-result")).not.toBeInTheDocument();
  });

  describe("CI badge mapping", () => {
    it.each([
      ["passing", "bg-success"],
      ["pending", "bg-warning"],
      ["failing", "bg-error"],
      ["neutral", "bg-muted"],
      ["unknown", "bg-muted"],
      ["some_unmapped_value", "bg-muted"],
    ])("overall=%s renders the %s badge class", async (overall, expectedClass) => {
      getPrAction.mockResolvedValue({
        ok: true,
        result: makePr({ ci: { overall, runs: [] } as never }),
      });
      getPrDiffAction.mockResolvedValue({ ok: true, result: { summary: "", files: [] } });
      const user = userEvent.setup();
      render(<PullRequestsTab scope={SCOPE} slug={SLUG} canManage={true} defaultHead={null} />);

      await user.type(screen.getByTestId("pr-lookup-input"), "42");
      await user.click(screen.getByTestId("pr-lookup-submit"));

      const badge = await screen.findByTestId("pr-ci-overall");
      expect(badge.className).toContain(expectedClass);
      expect(badge).toHaveTextContent(`CI: ${overall}`);
    });
  });
});
