// @vitest-environment jsdom
// Unlinking a repository, on its own: the warning a governed repository adds,
// the throw the action can end in, and Keep it linked, which writes nothing
// and forgets the refusal it showed.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryTree } from "@/data/contracts/repository";
import { IntlProvider } from "@/test/intl";
import type { RepositoryRow } from "./view";

const actions = vi.hoisted(() => ({ unlinkWorkspaceRepository: vi.fn() }));
vi.mock("./actions", () => actions);

const { UnlinkDialog } = await import("./unlink-dialog");

const GOVERNED_TREE: RepositoryTree = {
  bindingId: "rpb_link01",
  role: "linked",
  fullName: "acme/docs-site",
  productionBranch: "trunk",
  githubDefaultBranch: "trunk",
  head: "fedcba9876543210fedc",
  oxagen: { present: true, files: [".oxagen/workspace.toml"] },
  workspaceToml: null,
  governanceToml: null,
  governanceMode: "team",
  initPullRequest: null,
  readAt: "2026-09-19T10:00:00.000Z",
};

const ROW: RepositoryRow = {
  fullName: "acme/docs-site",
  owner: "acme",
  name: "docs-site",
  role: "linked",
  bindingId: "rpb_link01",
  productionBranch: "trunk",
  visibility: "private",
  htmlUrl: "https://github.com/acme/docs-site",
  events: "installed",
  connectionLive: true,
  tree: { kind: "ready", value: GOVERNED_TREE },
};

const onUnlinked = vi.fn();
const onClose = vi.fn();

/** The dialog opened on one row, closed the way the page closes it. */
function Harness() {
  const [row, setRow] = useState<RepositoryRow | null>(ROW);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setRow(ROW);
        }}
      >
        reopen
      </button>
      <UnlinkDialog
        org="acme"
        ws="core-platform"
        workspace="Core platform"
        row={row}
        onClose={() => {
          onClose();
          setRow(null);
        }}
        onUnlinked={onUnlinked}
      />
    </>
  );
}

beforeEach(() => {
  actions.unlinkWorkspaceRepository.mockReset();
  onUnlinked.mockReset();
  onClose.mockReset();
});
afterEach(cleanup);

describe("the unlink dialog", () => {
  it("warns that a governed repository's records stop steering runs here at once", async () => {
    render(
      <IntlProvider>
        <Harness />
      </IntlProvider>,
    );
    const dialog = await screen.findByTestId("unlink-dialog");
    expect(dialog).toHaveTextContent(
      "Unlink acme/docs-site from Core platform?",
    );
    expect(within(dialog).getByTestId("unlink-governed")).toHaveTextContent(
      "stop steering runs in Core platform",
    );
  });

  it("says it is unlinking while it waits, then names the call as unanswered when it throws (negative)", async () => {
    let fail!: (reason: unknown) => void;
    actions.unlinkWorkspaceRepository.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <Harness />
      </IntlProvider>,
    );
    const dialog = await screen.findByTestId("unlink-dialog");
    const submit = within(dialog).getByTestId("unlink-submit");
    await user.click(submit);
    expect(submit).toHaveTextContent("Unlinking");
    expect(submit).toBeDisabled();
    expect(actions.unlinkWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
    );
    await act(async () => {
      fail(new Error("offline"));
      await Promise.resolve();
    });
    expect(
      await within(dialog).findByTestId("unlink-failure"),
    ).toHaveTextContent("action_failed");
    expect(onUnlinked).not.toHaveBeenCalled();
  });

  it("keeps it linked on cancel, writing nothing and forgetting the refusal (negative)", async () => {
    actions.unlinkWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "main_repo_unlink_refused",
    });
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <Harness />
      </IntlProvider>,
    );
    const dialog = await screen.findByTestId("unlink-dialog");
    await user.click(within(dialog).getByTestId("unlink-submit"));
    expect(
      await within(dialog).findByTestId("unlink-failure"),
    ).toHaveTextContent("main repository cannot be unlinked");
    await user.click(
      within(dialog).getByRole("button", { name: "Keep it linked" }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("unlink-dialog")).toBeNull();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(actions.unlinkWorkspaceRepository).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "reopen" }));
    const reopened = await screen.findByTestId("unlink-dialog");
    expect(within(reopened).queryByTestId("unlink-failure")).toBeNull();
  });
});
