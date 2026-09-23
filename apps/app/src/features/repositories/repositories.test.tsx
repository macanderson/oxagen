// @vitest-environment jsdom
// The Repositories page over fake server actions: every state the page can be
// in (loading, loaded, empty, error, denied, phone width), every tab, and
// every action the mockup draws, each proven by what the actions were asked
// and what the page drew from their answers.
//
// The actions are the seam. They are proven against the real kernel seam in
// actions.test.ts; here they answer the way the capabilities answer, so what
// is under test is the page.
import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MouseEvent, ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  RepositoryChanges,
  RepositoryTree,
  WorkspaceRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { phoneWidth } from "@/test/phone";

const actions = vi.hoisted(() => ({
  readWorkspaceRepository: vi.fn(),
  listInstallationRepositories: vi.fn(),
  bindWorkspaceRepository: vi.fn(),
  listGithubInstallations: vi.fn(),
  attachGithubInstallation: vi.fn(),
  readWorkspaceRepositories: vi.fn(),
  linkWorkspaceRepository: vi.fn(),
  unlinkWorkspaceRepository: vi.fn(),
  readRepositoryTree: vi.fn(),
  setProductionBranch: vi.fn(),
  openInitPullRequest: vi.fn(),
  readRepositoryChanges: vi.fn(),
}));
vi.mock("./actions", () => actions);

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform/repositories",
  query: "",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    refresh: nav.refresh,
  }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      {...rest}
      onClick={(e) => {
        e.preventDefault(); // jsdom cannot navigate documents
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));

const { Repositories } = await import("./repositories");
const { Configuration } = await import("./configuration");
const { Changes } = await import("./changes");
const { useRepositoriesFailure } = await import("./failure");

const MAIN: WorkspaceRepositories["repositories"][number] = {
  bindingId: "rpb_main01",
  role: "main",
  owner: "acme",
  name: "platform",
  fullName: "acme/platform",
  defaultRef: "main",
  htmlUrl: "https://github.com/acme/platform",
  boundAt: "2026-09-16T10:00:00.000Z",
  connectionLive: true,
  events: "installed",
};
const LINKED: WorkspaceRepositories["repositories"][number] = {
  bindingId: "rpb_link01",
  role: "linked",
  owner: "acme",
  name: "docs-site",
  fullName: "acme/docs-site",
  defaultRef: "trunk",
  htmlUrl: "https://github.com/acme/docs-site",
  boundAt: "2026-09-17T10:00:00.000Z",
  connectionLive: true,
  events: "suspended",
};

const MAIN_TREE: RepositoryTree = {
  bindingId: "rpb_main01",
  role: "main",
  fullName: "acme/platform",
  productionBranch: "main",
  githubDefaultBranch: "main",
  head: "0123456789abcdef0123",
  oxagen: {
    present: true,
    files: [".oxagen/rules/governance.toml", ".oxagen/workspace.toml"],
  },
  workspaceToml: '[workspace]\nslug = "core-platform"\n',
  governanceToml: 'mode = "team"\n',
  governanceMode: "team",
  initPullRequest: null,
  readAt: "2026-09-19T10:00:00.000Z",
};
const LINKED_TREE: RepositoryTree = {
  bindingId: "rpb_link01",
  role: "linked",
  fullName: "acme/docs-site",
  productionBranch: "trunk",
  githubDefaultBranch: "main",
  head: "fedcba9876543210fedc",
  oxagen: { present: false, files: [] },
  workspaceToml: null,
  governanceToml: null,
  governanceMode: "absent",
  initPullRequest: null,
  readAt: "2026-09-19T10:00:00.000Z",
};

const CHANGES: RepositoryChanges = {
  changes: [
    {
      proposalId: "prp_open1",
      statement: "Never push to main",
      kind: "context_record",
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/platform/pull/42",
        repository: "acme/platform",
        branch: "oxagen/prp_open1",
      },
      openedBy: "the promoter",
      status: "checks_failed",
      checks: { passed: 3, total: 6 },
      openedAt: "2026-09-18T10:00:00.000Z",
    },
    {
      proposalId: "prp_done1",
      statement: "Run tests before a PR",
      kind: "context_record",
      pullRequest: {
        number: 41,
        url: "https://github.com/acme/platform/pull/41",
        repository: "acme/platform",
        branch: "oxagen/prp_done1",
      },
      openedBy: "user:mac",
      status: "merged",
      checks: { passed: 6, total: 6 },
      openedAt: "2026-09-17T10:00:00.000Z",
    },
  ],
  open: 1,
};

const BOUND_SETUP: WorkspaceRepository = {
  repository: {
    bindingId: "rpb_main01",
    provider: "github",
    owner: "acme",
    name: "platform",
    fullName: "acme/platform",
    defaultRef: "main",
    htmlUrl: "https://github.com/acme/platform",
    boundAt: "2026-09-16T10:00:00.000Z",
    connectionLive: true,
  },
  github: {
    connected: true,
    connectUrl: null,
    installUrl: null,
    manageUrl: "https://github.com/settings/installations/42",
  },
};

function page(
  tab:
    | "repositories"
    | "working-copies"
    | "changes"
    | "configuration" = "repositories",
  container?: HTMLElement,
) {
  return render(
    <IntlProvider>
      <Repositories
        org="acme"
        ws="core-platform"
        wsName="Core platform"
        tab={tab}
        roles={{ org: "member", workspace: "viewer" }}
      />
    </IntlProvider>,
    container ? { container } : undefined,
  );
}

async function loaded(
  tab:
    | "repositories"
    | "working-copies"
    | "changes"
    | "configuration" = "repositories",
) {
  const user = userEvent.setup();
  page(tab);
  const root = await screen.findByTestId("repositories-page");
  await waitFor(() => {
    expect(root.dataset.state).toBe("loaded");
  });
  return { user, root };
}

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  nav.query = "";
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of [nav.push, nav.replace, nav.refresh]) fn.mockReset();
  actions.readWorkspaceRepositories.mockResolvedValue({
    ok: true,
    value: { repositories: [MAIN, LINKED] },
  });
  actions.readRepositoryTree.mockImplementation(
    (_org: string, _ws: string, bindingId: string) =>
      Promise.resolve({
        ok: true,
        value: bindingId === MAIN.bindingId ? MAIN_TREE : LINKED_TREE,
      }),
  );
  actions.readRepositoryChanges.mockResolvedValue({ ok: true, value: CHANGES });
  actions.listInstallationRepositories.mockResolvedValue({
    ok: true,
    value: {
      repositories: [
        {
          id: "1",
          owner: "acme",
          name: "platform",
          fullName: "acme/platform",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/acme/platform",
        },
        {
          id: "3",
          owner: "acme",
          name: "infra",
          fullName: "acme/infra",
          defaultBranch: "main",
          private: true,
          htmlUrl: "https://github.com/acme/infra",
        },
      ],
      truncated: false,
    },
  });
  actions.readWorkspaceRepository.mockResolvedValue({
    ok: true,
    value: BOUND_SETUP,
  });
  actions.listGithubInstallations.mockResolvedValue({
    ok: false,
    reason: "conflict",
    code: "github_not_authorized",
  });
});
afterEach(cleanup);

describe("states", () => {
  it("shows the skeleton under the header while the list is read, never zeros", async () => {
    let answer!: (value: unknown) => void;
    actions.readWorkspaceRepositories.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    page();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Repositories",
    );
    expect(screen.getByTestId("repositories-loading")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    answer({ ok: true, value: { repositories: [MAIN] } });
    expect(
      await screen.findByRole("table", {
        name: "Repositories this workspace binds",
      }),
    ).toBeTruthy();
  });

  it("draws the loaded page: eyebrow, h1, one gold action, four tabs with live counts", async () => {
    const { root } = await loaded();
    expect(screen.getByText("Workspace Core platform")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Repository views" });
    const labels = within(tabs)
      .getAllByRole("link")
      .map((l) => l.textContent);
    await waitFor(() => {
      expect(
        within(tabs)
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual([
        "Repositories (2 linked)",
        "Working copies",
        "Changes (1 open)",
        "Configuration",
      ]);
    });
    expect(labels).toHaveLength(4);
    const gold = screen.getByTestId("repositories-add-oxagen");
    expect(gold.className).toContain("bg-button-primary-bg");
    // Exactly one gold action on the screen: the link-by-name submit and the
    // bound panel's re-approve sit beside the header's and give it up.
    await screen.findByTestId("workspace-repository-bound");
    await screen.findByTestId("workspace-repository-reachable");
    expect(
      Array.from(root.querySelectorAll("button, a")).filter((el) =>
        el.className.includes("bg-button-primary-bg"),
      ),
    ).toEqual([gold]);
    await expectNoAxe(root);
  });

  it("is the empty state, carrying the GitHub setup, when nothing is bound", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [] },
    });
    page();
    const empty = await screen.findByTestId("repositories-empty");
    expect(empty).toHaveTextContent("This workspace has no repository yet");
    expect(within(empty).getByTestId("repository-setup")).toBeTruthy();
    expect(screen.queryByTestId("repositories-add-oxagen")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Repository views" }),
    ).toBeNull();
    await expectNoAxe(empty);
  });

  it("is the error state with the code and Try again, which re-reads", async () => {
    actions.readWorkspaceRepositories.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "installation_unreachable",
    });
    const user = userEvent.setup();
    page();
    const error = await screen.findByTestId("repositories-error");
    expect(error).toHaveTextContent("Repositories could not be loaded");
    expect(error).toHaveTextContent("installation_unreachable");
    expect(error).toHaveTextContent("Nothing was changed.");
    await expectNoAxe(error);
    await user.click(screen.getByTestId("repositories-retry"));
    await waitFor(() => {
      expect(screen.getByTestId("repositories-page").dataset.state).toBe(
        "loaded",
      );
    });
    expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(2);
  });

  it("is the denied state naming the permission, with a way back to Fleet (negative)", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "repository.read",
    });
    page();
    const denied = await screen.findByTestId("repositories-denied");
    expect(denied).toHaveTextContent(
      "You cannot see this workspace’s repositories",
    );
    expect(denied).toHaveTextContent("repository.read");
    expect(screen.getByTestId("repositories-denied-roles")).toHaveTextContent(
      "member in the organization, viewer in this workspace",
    );
    expect(screen.getByTestId("repositories-back-to-fleet")).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(screen.queryByRole("table")).toBeNull();
    await expectNoAxe(denied);
  });

  it("keeps every control a 44px touch target at phone width", async () => {
    const phone = phoneWidth();
    try {
      page("repositories", phone.container);
      await within(phone.container).findByRole("table", {
        name: "Repositories this workspace binds",
      });
      const targets = phone.container.querySelectorAll("[data-touch-target]");
      expect(targets.length).toBeGreaterThan(3);
      for (const target of targets)
        expect(getComputedStyle(target).minHeight).toBe("44px");
    } finally {
      phone.restore();
    }
  });
});

describe("the Repositories tab", () => {
  it("lists main then linked with the mockup's columns, and the tree read per row", async () => {
    await loaded();
    const table = screen.getByRole("table", {
      name: "Repositories this workspace binds",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Repository",
      "Role",
      "Production branch",
      ".oxagen/",
      "Events",
      "Symbols",
      "Action",
    ]);
    const main = screen.getByTestId("workspace-repository-row-rpb_main01");
    expect(main).toHaveTextContent("main");
    expect(await within(main).findByText("governed · 2 files")).toBeTruthy();
    expect(main).toHaveTextContent("App installed");
    expect(main).toHaveTextContent("Not recorded yet");
    const linked = screen.getByTestId("workspace-repository-row-rpb_link01");
    expect(await within(linked).findByText("no .oxagen/")).toBeTruthy();
    expect(linked).toHaveTextContent("App suspended");
    expect(actions.readRepositoryTree).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
    );
  });

  it("warns that a linked repository with no .oxagen/ is steered by the main repo alone", async () => {
    await loaded();
    const banner = await screen.findByTestId("repositories-ungoverned");
    expect(banner).toHaveTextContent("acme/docs-site");
  });

  it("offers an unlink on the linked row and never on the main row", async () => {
    const { user } = await loaded();
    expect(
      screen.queryByTestId("workspace-repository-unlink-rpb_main01"),
    ).toBeNull();
    actions.unlinkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_link01",
        fullName: "acme/docs-site",
        unlinkedAt: "2026-09-19T10:00:00.000Z",
      },
    });
    await user.click(
      screen.getByTestId("workspace-repository-unlink-rpb_link01"),
    );
    const confirm = screen.getByTestId(
      "workspace-repository-unlink-confirm-rpb_link01",
    );
    await user.click(
      within(confirm).getByRole("button", { name: "Unlink it" }),
    );
    await waitFor(() => {
      expect(actions.unlinkWorkspaceRepository).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "rpb_link01",
      );
    });
    await waitFor(() => {
      expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(2);
    });
  });

  it("prints the unlink refusal on the row (negative)", async () => {
    const { user } = await loaded();
    actions.unlinkWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "repository_not_linked",
    });
    await user.click(
      screen.getByTestId("workspace-repository-unlink-rpb_link01"),
    );
    await user.click(screen.getByRole("button", { name: "Unlink it" }));
    expect(
      await screen.findByTestId(
        "workspace-repository-unlink-failure-rpb_link01",
      ),
    ).toHaveTextContent("no longer linked");
  });

  it("lists what the installation reaches and nobody bound, and links one", async () => {
    const { user } = await loaded();
    const reachable = await screen.findByTestId(
      "workspace-repository-reachable",
    );
    expect(within(reachable).queryByText("acme/platform")).toBeNull();
    const row = within(reachable).getByTestId(
      "workspace-repository-reachable-acme/infra",
    );
    expect(row).toHaveTextContent("not linked");
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_new01",
        fullName: "acme/infra",
        defaultRef: "main",
        linkedAt: "2026-09-19T10:00:00.000Z",
      },
    });
    await user.click(within(row).getByRole("button", { name: "Link" }));
    await waitFor(() => {
      expect(actions.linkWorkspaceRepository).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { owner: "acme", name: "infra" },
      );
    });
  });

  it("says nothing about reachable repositories when no installation is attached (negative)", async () => {
    actions.listInstallationRepositories.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    await loaded();
    await waitFor(() => {
      expect(actions.listInstallationRepositories).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("workspace-repository-reachable")).toBeNull();
    expect(
      screen.queryByTestId("workspace-repository-reachable-failure"),
    ).toBeNull();
  });

  it("links a repository by name, and refuses a name that is not owner/name (negative)", async () => {
    const { user } = await loaded();
    const form = screen.getByTestId("workspace-repository-link");
    const input = within(form).getByTestId("workspace-repository-link-input");
    await user.type(input, "not-a-repo");
    await user.click(within(form).getByRole("button", { name: "Link" }));
    expect(
      screen.getByTestId("workspace-repository-link-failure"),
    ).toHaveTextContent("owner/name");
    expect(actions.linkWorkspaceRepository).not.toHaveBeenCalled();
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_new02",
        fullName: "acme/api",
        defaultRef: "main",
        linkedAt: "2026-09-19T10:00:00.000Z",
      },
    });
    await user.clear(input);
    await user.type(input, "acme/api.git");
    await user.click(within(form).getByRole("button", { name: "Link" }));
    await waitFor(() => {
      expect(actions.linkWorkspaceRepository).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { owner: "acme", name: "api" },
      );
    });
  });

  it("states what linking does and the permissions it needs, writes included", async () => {
    await loaded();
    expect(screen.getByTestId("repositories-linking")).toHaveTextContent(
      "Confirms the production branch",
    );
    const permissions = screen.getByTestId("repositories-permissions");
    const table = within(permissions).getByRole("table", {
      name: "GitHub App permissions",
    });
    expect(table).toHaveTextContent("ContentsRead and write");
    expect(table).toHaveTextContent("Pull requestsRead and write");
    expect(table).toHaveTextContent("ChecksWrite");
    expect(permissions).toHaveTextContent(
      "Oxagen writes to a branch and never to the production branch.",
    );
  });

  it("carries the GitHub setup that used to live in Workspace settings", async () => {
    await loaded();
    expect(screen.getByTestId("repository-setup")).toBeTruthy();
    expect(
      await screen.findByTestId("workspace-repository-bound"),
    ).toBeTruthy();
  });
});

describe("the repository dialog", () => {
  it("shows the production branch and head, GitHub's default as a suggestion, and the unrecorded facts", async () => {
    const { user } = await loaded();
    await screen.findByText("governed · 2 files");
    await user.click(
      screen.getByTestId("workspace-repository-details-rpb_main01"),
    );
    const dialog = await screen.findByTestId("repository-dialog");
    expect(
      within(dialog).getByTestId("repository-dialog-branch"),
    ).toHaveTextContent("main");
    expect(
      within(dialog).getByTestId("repository-dialog-branch"),
    ).toHaveTextContent("head 0123456789ab");
    expect(
      within(dialog).getByTestId("repository-dialog-github-default"),
    ).toHaveTextContent("a suggestion, not the decision");
    expect(dialog).toHaveTextContent("Not recorded yet.");
    expect(
      within(dialog).getByTestId("repository-dialog-changes"),
    ).toBeTruthy();
    expect(
      within(dialog).queryByTestId("repository-dialog-add-oxagen"),
    ).toBeNull();
    await expectNoAxe(dialog);
  });

  it("offers GitHub's moved default branch as one click, through set_production_branch", async () => {
    const { user } = await loaded();
    await screen.findByText("no .oxagen/");
    await user.click(
      screen.getByTestId("workspace-repository-details-rpb_link01"),
    );
    const dialog = await screen.findByTestId("repository-dialog");
    expect(
      within(dialog).getByTestId("repository-dialog-branch-moved"),
    ).toHaveTextContent(
      "GitHub’s default branch is main. The production branch is still trunk.",
    );
    expect(
      within(dialog).getByTestId("repository-dialog-ungoverned"),
    ).toBeTruthy();
    actions.setProductionBranch.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_link02",
        fullName: "acme/docs-site",
        productionBranch: "main",
        previousBranch: "trunk",
        changed: true,
      },
    });
    // The re-read after the change answers the successor binding version.
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: {
        repositories: [
          MAIN,
          { ...LINKED, bindingId: "rpb_link02", defaultRef: "main" },
        ],
      },
    });
    await user.click(
      within(dialog).getByTestId("repository-dialog-branch-use-suggestion"),
    );
    expect(
      await within(dialog).findByTestId("repository-dialog-branch-done"),
    ).toHaveTextContent("moved from trunk to main");
    // The dialog follows the new binding id rather than closing on the old one.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("repository-dialog")).getByTestId(
          "repository-dialog-branch",
        ),
      ).toHaveTextContent("main");
    });
    expect(
      within(screen.getByTestId("repository-dialog")).getByTestId(
        "repository-dialog-branch-done",
      ),
    ).toHaveTextContent("moved from trunk to main");
    expect(actions.setProductionBranch).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
      "main",
    );
  });

  it("prints branch_not_found and writes nothing else (negative)", async () => {
    const { user } = await loaded();
    await screen.findByText("governed · 2 files");
    await user.click(
      screen.getByTestId("workspace-repository-details-rpb_main01"),
    );
    const dialog = await screen.findByTestId("repository-dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Set production branch" }),
    );
    expect(
      within(dialog).getByTestId("repository-dialog-branch-failure"),
    ).toHaveTextContent("Name a branch first.");
    expect(actions.setProductionBranch).not.toHaveBeenCalled();
    actions.setProductionBranch.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "branch_not_found",
    });
    await user.type(
      within(dialog).getByTestId("repository-dialog-branch-input"),
      "release",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Set production branch" }),
    );
    expect(
      await within(dialog).findByTestId("repository-dialog-branch-failure"),
    ).toHaveTextContent("GitHub has no branch by that name");
  });
});

describe("the init wizard", () => {
  it("walks five steps and opens the pull request with both reviewed files", async () => {
    const { user } = await loaded();
    await screen.findByText("no .oxagen/");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    const steps = within(wizard).getByRole("list", { name: "Steps" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((s) => s.textContent),
    ).toEqual([
      "1. Repository",
      "2. Branch and governance",
      "3. Permissions",
      "4. Review",
      "5. Pull request",
    ]);
    expect(within(steps).getByText("1. Repository")).toHaveAttribute(
      "aria-current",
      "step",
    );

    // Only the repository with no .oxagen/ is offered.
    const repository = within(wizard).getByTestId("init-wizard-repository");
    expect(within(repository).queryByText("acme/platform")).toBeNull();
    await user.click(within(repository).getByRole("radio"));
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const branch = within(wizard).getByTestId("init-wizard-branch");
    expect(branch).toHaveTextContent("merges into trunk");
    expect(branch).toHaveTextContent(
      "GitHub’s default branch is main. That is a suggestion, not the decision.",
    );
    await user.click(within(branch).getByRole("radio", { name: /regulated/ }));
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const permissions = within(wizard).getByTestId("init-wizard-permissions");
    expect(permissions).toHaveTextContent(
      "It merges only what a person merges.",
    );
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const governance = within(wizard).getByTestId<HTMLTextAreaElement>(
      "init-wizard-governance-toml",
    );
    expect(governance.value).toContain('mode = "regulated"');
    const workspace = within(wizard).getByTestId<HTMLTextAreaElement>(
      "init-wizard-workspace-toml",
    );
    expect(workspace.value).toContain('name = "acme/docs-site"');
    await user.type(workspace, "# reviewed");
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const pr = within(wizard).getByTestId("init-wizard-pull-request");
    expect(pr).toHaveTextContent("A pull request to acme/docs-site");
    expect(pr).toHaveTextContent("Opened from oxagen/init into trunk.");
    expect(pr).toHaveTextContent(".gitignore");
    actions.openInitPullRequest.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/docs-site",
        branch: "oxagen/init",
        base: "trunk",
        pullRequest: {
          number: 7,
          htmlUrl: "https://github.com/acme/docs-site/pull/7",
        },
        files: [".oxagen/workspace.toml", ".oxagen/rules/governance.toml"],
        reused: false,
      },
    });
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    const opened = await within(wizard).findByTestId("init-wizard-opened");
    expect(opened).toHaveTextContent(
      "Pull request #7 is open on acme/docs-site, into trunk.",
    );
    expect(within(opened).getByTestId("init-wizard-pr-link")).toHaveAttribute(
      "href",
      "https://github.com/acme/docs-site/pull/7",
    );
    const call = actions.openInitPullRequest.mock.calls[0];
    expect(call?.[2]).toMatchObject({
      bindingId: "rpb_link01",
      governanceMode: "regulated",
    });
    // The edit made on Review is what went out.
    const sent: unknown = call?.[2];
    expect(sent).toHaveProperty("workspaceToml");
    expect(JSON.stringify(sent)).toContain("# reviewed");
    await expectNoAxe(wizard);
  });

  it("prints a refusal and stays on the last step (negative)", async () => {
    const { user } = await loaded();
    await screen.findByText("no .oxagen/");
    await user.click(
      screen.getByTestId("workspace-repository-details-rpb_link01"),
    );
    await user.click(await screen.findByTestId("repository-dialog-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    // Opened from a repository, the wizard starts on Branch and governance.
    expect(within(wizard).getByTestId("init-wizard-branch")).toBeTruthy();
    for (let i = 0; i < 3; i += 1)
      await user.click(within(wizard).getByTestId("init-wizard-next"));
    actions.openInitPullRequest.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "oxagen_tree_exists",
    });
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    expect(
      await within(wizard).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("already has .oxagen/");
    expect(within(wizard).getByTestId("init-wizard-pull-request")).toBeTruthy();
  });

  it("says so when no repository is left to initialise (negative)", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [MAIN] },
    });
    const { user } = await loaded();
    await screen.findByText("governed · 2 files");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    expect(
      within(wizard).getByTestId("init-wizard-no-candidates"),
    ).toBeTruthy();
    expect(within(wizard).getByTestId("init-wizard-next")).toBeDisabled();
  });
});

describe("the other tabs", () => {
  it("Working copies: the behind-is-not-behind note, the two files, and the gold moves to Connect a directory", async () => {
    const { user } = await loaded("working-copies");
    expect(screen.getByTestId("working-copies-behind-note")).toHaveTextContent(
      "A working copy that is behind is not a run that is behind.",
    );
    expect(screen.getByTestId("working-copies-not-recorded")).toBeTruthy();
    expect(screen.getByTestId("working-copies-two-files")).toBeTruthy();
    expect(
      screen.getByTestId("repositories-add-oxagen").className,
    ).not.toContain("bg-button-primary-bg");
    const connect = screen.getByTestId("working-copies-connect");
    expect(connect.className).toContain("bg-button-primary-bg");
    await user.click(connect);
    const dialog = await screen.findByTestId("connect-directory-dialog");
    expect(dialog).toHaveTextContent("oxagen init");
    expect(dialog).toHaveTextContent("Linking a directory grants nothing.");
    await expectNoAxe(dialog);
  });

  it("Changes: every Context PR with its kind, opener, state and checks; each opens its panel", async () => {
    await loaded("changes");
    const table = await screen.findByRole("table", {
      name: "Pull requests Oxagen opened",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Change",
      "Kind",
      "Pull request",
      "Opened by",
      "State",
      "Checks",
      "Opened",
    ]);
    const failed = table.querySelector('[data-change="prp_open1"]');
    expect(failed).toHaveTextContent("Checks failed");
    expect(failed).toHaveTextContent("3/6");
    expect(failed).toHaveTextContent("the promoter");
    expect(screen.getByTestId("change-open-prp_open1")).toHaveAttribute(
      "href",
      "/acme/core-platform/steering/proposals/prs?proposal=prp_open1",
    );
    expect(screen.getByTestId("changes-who-opens")).toHaveTextContent(
      "Drift is reported, never repaired in place.",
    );
    await expectNoAxe(screen.getByTestId("changes"));
  });

  it("Changes: says when there is nothing, and prints a refusal (negative)", async () => {
    actions.readRepositoryChanges.mockResolvedValue({
      ok: true,
      value: { changes: [], open: 0 },
    });
    await loaded("changes");
    expect(await screen.findByTestId("changes-empty")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Repository views" });
    expect(within(tabs).getByText("Changes")).toBeTruthy();
    cleanup();
    actions.readRepositoryChanges.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "repository.read",
    });
    await loaded("changes");
    expect(await screen.findByTestId("changes-failure")).toHaveTextContent(
      "Only an organization Owner or Admin",
    );
  });

  it("Configuration: workspace.toml at its commit, the mode, drift said as unrecorded, and the tree", async () => {
    await loaded("configuration");
    const config = await screen.findByTestId("configuration");
    expect(config).toHaveTextContent(
      "As it is on acme/platform, branch main, at commit 0123456789ab.",
    );
    expect(
      screen.getByTestId("configuration-workspace-toml"),
    ).toHaveTextContent('slug = "core-platform"');
    expect(screen.getByTestId("configuration-mode")).toHaveTextContent(
      "mode: team",
    );
    expect(screen.getByTestId("configuration-drift")).toHaveTextContent(
      "Not recorded yet.",
    );
    expect(screen.getByTestId("configuration-tree")).toHaveTextContent(
      ".oxagen/workspace.toml",
    );
    await expectNoAxe(config);
  });

  it("Configuration: an invalid governance.toml reads as refusing both (negative)", async () => {
    actions.readRepositoryTree.mockResolvedValue({
      ok: true,
      value: { ...MAIN_TREE, governanceMode: "invalid" },
    });
    await loaded("configuration");
    expect(await screen.findByTestId("configuration-mode")).toHaveTextContent(
      "opening and merging are both refused",
    );
  });
});

describe("repository refusal messages", () => {
  it.each([
    ["github_not_connected", "Install the App first"],
    ["repository_not_installed", "Grant it access on GitHub"],
    ["main_repo_bound", "already binds a different main repository"],
    ["github_not_authorized", "Connect GitHub first"],
    ["installation_unreachable", "cannot reach that installation"],
    ["main_repo", "never also linked"],
    ["repository_already_linked", "already linked to this workspace"],
    ["main_repo_claimed", "Another workspace steers by that repository"],
    ["main_repo_unbound", "main repository first"],
    ["repository_linked_elsewhere", "Another workspace has linked"],
    ["main_repo_unlink_refused", "main repository cannot be unlinked"],
    ["repository_not_linked", "Reload the page"],
    ["branch_not_found", "Check the spelling"],
    ["production_branch_missing", "Set the production branch first"],
    ["production_branch_is_init_branch", "Set another production branch first"],
    ["oxagen_tree_exists", "Change it with an ordinary pull request"],
    ["governance_toml_invalid", "Fix the file or pick the mode"],
    ["workspace_toml_invalid", "not valid TOML"],
    ["secret_found", "credential or personal data"],
    ["authority_declared", "grant of authority"],
    ["github_refused", "Check that the App can write"],
  ])("explains how to recover from %s", (code, recovery) => {
    const { result } = renderHook(useRepositoriesFailure, {
      wrapper: IntlProvider,
    });
    for (const reason of ["conflict", "not_found"] as const)
      expect(result.current({ ok: false, reason, code })).toContain(recovery);
  });

  it("preserves unknown refusal codes and approval request identifiers", () => {
    const { result } = renderHook(useRepositoriesFailure, {
      wrapper: IntlProvider,
    });
    expect(
      result.current({ ok: false, reason: "conflict", code: "future_refusal" }),
    ).toBe("This was refused: future_refusal.");
    expect(
      result.current({
        ok: false,
        reason: "pending_approval",
        accessRequestId: "apr_123",
      }),
    ).toContain("Request apr_123 is waiting");
    expect(
      result.current({ ok: false, reason: "invalid", code: "invalid_input" }),
    ).toContain("not one GitHub accepts");
    expect(
      result.current({ ok: false, reason: "denied", code: "authz_denied" }),
    ).toContain("Only an organization Owner or Admin");
    expect(
      result.current({
        ok: false,
        reason: "exhausted",
        code: "budget_exceeded",
      }),
    ).toContain("budget_exceeded");
    expect(
      result.current({
        ok: false,
        reason: "unavailable",
        code: "action_failed",
      }),
    ).toContain("action_failed");
  });
});

describe("configuration read states", () => {
  it("distinguishes an unbound workspace from a pending read", () => {
    const view = render(
      <IntlProvider>
        <Configuration mainFullName={null} tree={undefined} />
      </IntlProvider>,
    );
    expect(screen.getByTestId("configuration-no-main")).toHaveTextContent(
      "binds no main repository",
    );
    view.rerender(
      <IntlProvider>
        <Configuration mainFullName="acme/platform" tree={undefined} />
      </IntlProvider>,
    );
    expect(screen.getByTestId("configuration-loading")).toHaveTextContent(
      "acme/platform",
    );
    view.rerender(
      <IntlProvider>
        <Configuration
          mainFullName="acme/platform"
          tree={{ kind: "loading" }}
        />
      </IntlProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reading .oxagen/");
  });

  it("shows a read refusal without presenting stale configuration", () => {
    render(
      <IntlProvider>
        <Configuration
          mainFullName="acme/platform"
          tree={{
            kind: "failed",
            failure: { ok: false, reason: "unavailable", code: "github_down" },
          }}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("configuration-failure")).toHaveTextContent(
      "github_down",
    );
    expect(screen.queryByTestId("configuration-workspace-toml")).toBeNull();
  });

  it("explains a missing branch and absent files without inventing content", () => {
    render(
      <IntlProvider>
        <Configuration
          mainFullName="acme/platform"
          tree={{
            kind: "ready",
            value: {
              ...MAIN_TREE,
              head: null,
              workspaceToml: null,
              governanceToml: null,
              governanceMode: "absent",
              oxagen: { present: false, files: [] },
            },
          }}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("configuration")).toHaveTextContent(
      "production branch main no longer exists",
    );
    expect(
      screen.getByTestId("configuration-workspace-toml"),
    ).toHaveTextContent("Not on the production branch yet");
    expect(screen.getByTestId("configuration-governance")).toHaveTextContent(
      "No governance.toml",
    );
    expect(screen.getByTestId("configuration-tree")).toHaveTextContent(
      "No .oxagen/ on the production branch",
    );
    expect(document.querySelector("pre")).toBeNull();
  });
});

describe("change read states", () => {
  it("shows a pending read before any change rows exist", () => {
    render(
      <IntlProvider>
        <Changes org="acme" ws="core-platform" changes={{ kind: "loading" }} />
      </IntlProvider>,
    );
    expect(screen.getByTestId("changes-loading")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByTestId("changes-empty")).toBeNull();
  });

  it("prints an unsafe pull request URL as text and distinguishes unreported checks", () => {
    const [change] = CHANGES.changes;
    if (change === undefined) throw new Error("Expected a change fixture");
    render(
      <IntlProvider>
        <Changes
          org="acme"
          ws="core-platform"
          changes={{
            kind: "ready",
            value: {
              open: 1,
              changes: [
                {
                  ...change,
                  checks: null,
                  pullRequest: {
                    ...change.pullRequest,
                    url: "https://example.com/acme/platform/pull/42",
                  },
                },
              ],
            },
          }}
        />
      </IntlProvider>,
    );
    const label = screen.getByText("acme/platform#42");
    expect(label.closest("a")).toBeNull();
    expect(screen.getByTestId("change-open-prp_open1")).toHaveAttribute(
      "href",
      expect.stringContaining("steering"),
    );
    expect(screen.getByTestId("changes")).not.toHaveTextContent("3/6");
  });
});
