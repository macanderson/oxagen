// @vitest-environment jsdom
// One repository's dialog on its own, over rows in the states the page test
// does not reach: a tree that could not be read, a production branch GitHub
// no longer has, a governed linked repository, an init pull request waiting,
// a retired steering connection, and a production branch that did not move. A link
// opens a steering PR (ADR-212), so the dialog names that PR and says to merge
// it, or says the next steering sync links a repository workspace.toml lists.
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
import { expectNoAxe } from "@/test/expect-no-axe";
import type { RepositoryTree } from "@/data/contracts/repository";
import { IntlProvider } from "@/test/intl";
import type { RepositoryRow } from "./view";

const actions = vi.hoisted(() => ({
  linkWorkspaceRepository: vi.fn(),
  setProductionBranch: vi.fn(),
}));
vi.mock("./actions", () => actions);

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/core-platform/repositories",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { RepositoryDialog } = await import("./repository-dialog");

const TREE: RepositoryTree = {
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

const LINKED: RepositoryRow = {
  fullName: "acme/docs-site",
  owner: "acme",
  name: "docs-site",
  role: "linked",
  bindingId: "rpb_link01",
  productionBranch: "trunk",
  visibility: "public",
  htmlUrl: "https://github.com/acme/docs-site",
  events: "installed",
  connectionLive: true,
  tree: { kind: "ready", value: TREE },
};

const handlers = {
  onClose: vi.fn(),
  onChanged: vi.fn(),
  onUnlink: vi.fn(),
  onAddOxagen: vi.fn(),
  onSeeChanges: vi.fn(),
};

function dialog(
  row: RepositoryRow,
  mainFullName: string | null = "acme/platform",
) {
  render(
    <IntlProvider>
      <RepositoryDialog
        org="acme"
        ws="core-platform"
        workspace="Core platform"
        mainFullName={mainFullName}
        row={row}
        {...handlers}
      />
    </IntlProvider>,
  );
  return screen.getByTestId("repository-dialog");
}

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(handlers)])
    fn.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the repository dialog", () => {
  it("prints why the tree could not be read, and offers neither its changes nor Add Oxagen (negative)", () => {
    const root = dialog({
      ...LINKED,
      tree: {
        kind: "failed",
        failure: { ok: false, reason: "unavailable", code: "github_down" },
      },
    });
    expect(
      within(root).getByTestId("repository-dialog-tree-failure"),
    ).toHaveTextContent("github_down");
    expect(within(root).queryByTestId("repository-dialog-changes")).toBeNull();
    expect(
      within(root).queryByTestId("repository-dialog-add-oxagen"),
    ).toBeNull();
    expect(
      within(root).queryByTestId("repository-dialog-ungoverned"),
    ).toBeNull();
  });

  it("says the production branch is missing on GitHub when the read found no head", () => {
    const root = dialog({
      ...LINKED,
      tree: { kind: "ready", value: { ...TREE, head: null } },
    });
    expect(
      within(root).getByTestId("repository-dialog-branch"),
    ).toHaveTextContent("trunk is missing on GitHub");
  });

  // #3340: every record lives in the steering repository (ADR-212), so the
  // dialog promises a linked repository no records and no pull requests.
  it("says a governed linked repository's records live in the steering repository, and links to its changes", async () => {
    const user = userEvent.setup();
    const root = dialog(LINKED);
    expect(root).toHaveTextContent(
      "Every record lives in the steering repository",
    );
    expect(root).not.toHaveTextContent("Scope is repository");
    expect(root).not.toHaveTextContent("Steering PR");
    expect(root).toHaveTextContent("1 file at fedcba9");
    await user.click(within(root).getByTestId("repository-dialog-changes"));
    expect(handlers.onSeeChanges).toHaveBeenCalledTimes(1);
  });

  it("says a linked repository with no tree is steered by the repository it names when no main repository is bound", () => {
    const root = dialog(
      {
        ...LINKED,
        tree: {
          kind: "ready",
          value: { ...TREE, oxagen: { present: false, files: [] } },
        },
      },
      null,
    );
    expect(
      within(root).getByTestId("repository-dialog-ungoverned"),
    ).toHaveTextContent("steered by acme/docs-site, where every record lives");
  });

  it("points at the init pull request that is waiting to be merged", () => {
    const root = dialog({
      ...LINKED,
      tree: {
        kind: "ready",
        value: {
          ...TREE,
          oxagen: { present: false, files: [] },
          initPullRequest: {
            number: 7,
            htmlUrl: "https://github.com/acme/docs-site/pull/7",
          },
        },
      },
    });
    const init = within(root).getByTestId("repository-dialog-init-pr");
    expect(init).toHaveTextContent(
      "Pull request #7 adds .oxagen/ and is waiting for a person to merge it.",
    );
    expect(within(init).getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/acme/docs-site/pull/7",
    );
  });

  it("says steering is off when the steering repository's connection was retired, and offers no repair", () => {
    const root = dialog({
      ...LINKED,
      role: "main",
      fullName: "acme/platform",
      connectionLive: false,
    });
    const retired = within(root).getByRole("region", {
      name: "Connection retired",
    });
    expect(
      within(retired).getByTestId("repository-dialog-retired"),
    ).toHaveTextContent(
      "This steering repository's connection was retired, so steering is off.",
    );
    expect(within(retired).queryByRole("button")).toBeNull();
    expect(within(root).queryByTestId("repository-setup")).toBeNull();
  });

  it("says nothing was written when the branch typed is already the production branch (negative)", async () => {
    actions.setProductionBranch.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_link01",
        fullName: "acme/docs-site",
        productionBranch: "trunk",
        previousBranch: "trunk",
        changed: false,
      },
    });
    const user = userEvent.setup();
    const root = dialog(LINKED);
    await user.type(
      within(root).getByTestId("repository-dialog-branch-input"),
      "trunk",
    );
    await user.click(
      within(root).getByRole("button", { name: "Set production branch" }),
    );
    await waitFor(() => {
      expect(root).toHaveTextContent(
        "trunk is already the production branch. Nothing was written.",
      );
    });
    expect(handlers.onChanged).not.toHaveBeenCalled();
  });

  it("names the call as unanswered when the branch write throws (negative)", async () => {
    actions.setProductionBranch.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    const root = dialog(LINKED);
    await user.type(
      within(root).getByTestId("repository-dialog-branch-input"),
      "release",
    );
    await user.click(
      within(root).getByRole("button", { name: "Set production branch" }),
    );
    await waitFor(() => {
      expect(root).toHaveTextContent("action_failed");
    });
    expect(handlers.onChanged).not.toHaveBeenCalled();
  });

  const AVAILABLE: RepositoryRow = {
    ...LINKED,
    role: "available",
    bindingId: null,
    events: null,
    tree: null,
  };

  it("names the steering PR a link opened and says to merge it", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/docs-site",
        defaultRef: "trunk",
        status: "proposed",
        steeringPullRequest: {
          number: 43,
          url: "https://github.com/acme/platform/pull/43",
          reused: false,
        },
      },
    });
    const user = userEvent.setup();
    const root = dialog(AVAILABLE);
    await user.click(within(root).getByTestId("repository-dialog-link"));
    const linked = await within(root).findByTestId("repository-dialog-linked");
    expect(linked).toHaveAttribute("data-state", "proposed");
    expect(linked).toHaveTextContent(
      "Steering PR #43 adds acme/docs-site to workspace.toml.",
    );
    expect(within(root).getByTestId("repository-dialog-issues")).toHaveTextContent(
      "Once the link merges, turn on Issues in this repository's row to collect its open issues as work items.",
    );
    expect(linked).toHaveTextContent(
      "Merge the steering PR to finish linking.",
    );
    const link = within(linked).getByTestId("repository-dialog-linked-link");
    expect(link).toHaveTextContent("#43");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/acme/platform/pull/43",
    );
    expect(within(root).queryByTestId("repository-dialog-link")).toBeNull();
    expect(handlers.onChanged).toHaveBeenCalledTimes(1);
  });

  it("says the steering PR was already open when the link reused it", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/docs-site",
        defaultRef: "trunk",
        status: "proposed",
        steeringPullRequest: {
          number: 43,
          url: "https://github.com/acme/platform/pull/43",
          reused: true,
        },
      },
    });
    const user = userEvent.setup();
    const root = dialog(AVAILABLE);
    await user.click(within(root).getByTestId("repository-dialog-link"));
    const linked = await within(root).findByTestId("repository-dialog-linked");
    expect(linked).toHaveAttribute("data-state", "reused");
    expect(linked).toHaveTextContent(
      "Steering PR #43 already adds acme/docs-site to workspace.toml.",
    );
    expect(linked).toHaveTextContent(
      "Merge the steering PR to finish linking.",
    );
  });

  it("says the next steering sync links a repository workspace.toml lists already", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/docs-site",
        defaultRef: "trunk",
        status: "listed",
        steeringPullRequest: null,
      },
    });
    const user = userEvent.setup();
    const root = dialog(AVAILABLE);
    await user.click(within(root).getByTestId("repository-dialog-link"));
    const linked = await within(root).findByTestId("repository-dialog-linked");
    expect(linked).toHaveAttribute("data-state", "listed");
    expect(linked).toHaveTextContent(
      "workspace.toml lists acme/docs-site already. The next steering sync links it.",
    );
    expect(
      within(linked).queryByTestId("repository-dialog-linked-link"),
    ).toBeNull();
    expect(linked).not.toHaveTextContent("Merge the steering PR");
  });

  it("names the refusal when workspace.toml is present but unreadable (negative)", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "workspace_toml_unreadable",
    });
    const user = userEvent.setup();
    const root = dialog(AVAILABLE);
    await user.click(within(root).getByTestId("repository-dialog-link"));
    expect(
      await within(root).findByTestId("repository-dialog-failure"),
    ).toHaveTextContent("workspace.toml is present but unreadable");
    expect(within(root).queryByTestId("repository-dialog-linked")).toBeNull();
    expect(handlers.onChanged).not.toHaveBeenCalled();
  });

  it("names the call as unanswered when linking throws (negative)", async () => {
    actions.linkWorkspaceRepository.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    const root = dialog({
      ...LINKED,
      role: "available",
      bindingId: null,
      events: null,
      tree: null,
    });
    await user.click(within(root).getByTestId("repository-dialog-link"));
    expect(
      await within(root).findByTestId("repository-dialog-failure"),
    ).toHaveTextContent("action_failed");
    expect(handlers.onChanged).not.toHaveBeenCalled();
  });
});
