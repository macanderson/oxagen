// @vitest-environment jsdom
/**
 * files-tab.test.tsx — unit tests for FilesTab.
 *
 * Covers: the no-slug empty state, the canManage gate (a non-manager sees a
 * plain notice, not the form), submit validation (disabled until
 * path/message/branch are all present), a successful commit (renders the
 * result + diff patches), and a failed commit (shows the error).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesTab } from "./files-tab";

const { putRepoFileAction } = vi.hoisted(() => ({
  putRepoFileAction: vi.fn(),
}));

vi.mock("../actions", () => ({ putRepoFileAction }));

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const SLUG = { owner: "acme", repo: "widgets" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FilesTab", () => {
  it("renders the setup-incomplete empty state when slug is null", () => {
    render(<FilesTab scope={SCOPE} slug={null} canManage={true} />);

    expect(screen.getByText("Repo setup incomplete")).toBeInTheDocument();
    expect(screen.queryByTestId("repo-files-tab")).not.toBeInTheDocument();
  });

  it("shows a plain notice instead of the form for a non-manager", () => {
    render(<FilesTab scope={SCOPE} slug={SLUG} canManage={false} />);

    expect(
      screen.getByText("Only workspace owners and admins can commit files."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("repo-files-tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("file-commit-submit")).not.toBeInTheDocument();
  });

  it("disables submit until path, message, and branch are all filled in", async () => {
    const user = userEvent.setup();
    render(<FilesTab scope={SCOPE} slug={SLUG} canManage={true} />);

    const submit = screen.getByTestId("file-commit-submit");
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId("file-path-input"), "src/index.ts");
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId("file-branch-input"), "feature/x");
    expect(submit).toBeDisabled();

    await user.type(screen.getByTestId("file-message-input"), "Update index");
    expect(submit).toBeEnabled();
  });

  it("submit success renders the commit result and diff patches", async () => {
    putRepoFileAction.mockResolvedValue({
      ok: true,
      result: {
        htmlUrl: "https://github.com/acme/widgets/blob/feature/x/src/index.ts",
        commitSha: "abcdef1234567890abcdef",
        diffs: [{ path: "src/index.ts", patch: "+console.log('hi')" }],
      },
    });
    const user = userEvent.setup();
    render(<FilesTab scope={SCOPE} slug={SLUG} canManage={true} />);

    await user.type(screen.getByTestId("file-path-input"), "src/index.ts");
    await user.type(screen.getByTestId("file-branch-input"), "feature/x");
    await user.type(screen.getByTestId("file-content-input"), "console.log('hi')");
    await user.type(screen.getByTestId("file-message-input"), "Update index");
    await user.click(screen.getByTestId("file-commit-submit"));

    const result = await screen.findByTestId("file-commit-result");
    expect(result).toHaveTextContent("abcdef123456");
    expect(result).toHaveTextContent("+console.log('hi')");
    expect(putRepoFileAction).toHaveBeenCalledWith(
      expect.objectContaining({
        ...SCOPE,
        ...SLUG,
        path: "src/index.ts",
        branch: "feature/x",
        content: "console.log('hi')",
        message: "Update index",
      }),
    );
  });

  it("submit error shows the error message and no result", async () => {
    putRepoFileAction.mockResolvedValue({ ok: false, error: "File is locked by another agent" });
    const user = userEvent.setup();
    render(<FilesTab scope={SCOPE} slug={SLUG} canManage={true} />);

    await user.type(screen.getByTestId("file-path-input"), "src/index.ts");
    await user.type(screen.getByTestId("file-branch-input"), "feature/x");
    await user.type(screen.getByTestId("file-message-input"), "Update index");
    await user.click(screen.getByTestId("file-commit-submit"));

    expect(await screen.findByText("File is locked by another agent")).toBeInTheDocument();
    expect(screen.queryByTestId("file-commit-result")).not.toBeInTheDocument();
  });
});
