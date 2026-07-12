// @vitest-environment jsdom
/**
 * branches-tab.test.tsx — unit tests for BranchesTab.
 *
 * Covers: the no-slug empty state, the create form's canManage gate, submit
 * validation (disabled until a name is entered), a successful create
 * (appends to the this-session list, calls onBranchCreated, resets the
 * form), and a failed create (shows the error, list unchanged).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BranchesTab } from "./branches-tab";

const { createBranchAction } = vi.hoisted(() => ({
  createBranchAction: vi.fn(),
}));

vi.mock("../actions", () => ({ createBranchAction }));

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const SLUG = { owner: "acme", repo: "widgets" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BranchesTab", () => {
  it("renders the setup-incomplete empty state when slug is null", () => {
    render(<BranchesTab scope={SCOPE} slug={null} canManage={true} onBranchCreated={vi.fn()} />);

    expect(screen.getByText("Repo setup incomplete")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-branches-tab")).not.toBeInTheDocument();
  });

  it("hides the create form for a non-manager but still shows the this-session list", () => {
    render(<BranchesTab scope={SCOPE} slug={SLUG} canManage={false} onBranchCreated={vi.fn()} />);

    expect(screen.queryByTestId("branch-name-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("branch-create-submit")).not.toBeInTheDocument();
    expect(screen.getByText("No branches created this session")).toBeInTheDocument();
  });

  it("disables submit until a branch name is entered", async () => {
    const user = userEvent.setup();
    render(<BranchesTab scope={SCOPE} slug={SLUG} canManage={true} onBranchCreated={vi.fn()} />);

    expect(screen.getByTestId("branch-create-submit")).toBeDisabled();

    await user.type(screen.getByTestId("branch-name-input"), "feature/x");
    expect(screen.getByTestId("branch-create-submit")).toBeEnabled();

    await user.clear(screen.getByTestId("branch-name-input"));
    expect(screen.getByTestId("branch-create-submit")).toBeDisabled();
  });

  it("submit success appends to the this-session list, notifies the parent, and resets the form", async () => {
    createBranchAction.mockResolvedValue({
      ok: true,
      result: { ref: "refs/heads/feature/x", sha: "abcdef1234567890" },
    });
    const onBranchCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <BranchesTab scope={SCOPE} slug={SLUG} canManage={true} onBranchCreated={onBranchCreated} />,
    );

    await user.type(screen.getByTestId("branch-name-input"), "feature/x");
    await user.type(screen.getByLabelText("From branch (optional)"), "main");
    await user.click(screen.getByTestId("branch-create-submit"));

    const list = await screen.findByTestId("created-branches-list");
    expect(within(list).getByText("feature/x")).toBeInTheDocument();
    expect(within(list).getByText("abcdef12")).toBeInTheDocument();
    expect(screen.queryByText("No branches created this session")).not.toBeInTheDocument();

    expect(createBranchAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ...SCOPE,
        ...SLUG,
        branch: "feature/x",
        fromBranch: "main",
      }),
    );
    expect(onBranchCreated).toHaveBeenCalledWith("feature/x");
    expect(screen.getByTestId("branch-name-input")).toHaveValue("");
  });

  it("submit error shows the error message and leaves the list empty", async () => {
    createBranchAction.mockResolvedValue({ ok: false, error: "Branch already exists" });
    const user = userEvent.setup();
    render(<BranchesTab scope={SCOPE} slug={SLUG} canManage={true} onBranchCreated={vi.fn()} />);

    await user.type(screen.getByTestId("branch-name-input"), "feature/x");
    await user.click(screen.getByTestId("branch-create-submit"));

    expect(await screen.findByText("Branch already exists")).toBeInTheDocument();
    expect(screen.queryByTestId("created-branches-list")).not.toBeInTheDocument();
    expect(screen.getByText("No branches created this session")).toBeInTheDocument();
  });
});
