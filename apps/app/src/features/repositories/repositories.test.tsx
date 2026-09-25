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
  readRepositoryChange: vi.fn(),
  mergeRepositoryChange: vi.fn(),
  closeRepositoryChange: vi.fn(),
  readWorkingCopies: vi.fn(),
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

/** The open change the Changes tab lists first. */
const OPEN_CHANGE: RepositoryChanges["changes"][number] = {
  proposalId: "prp_open1",
  lineage: "ctx.scr.001-never-push-to-main",
  statement: "Never push to main",
  why: "Main is shared and contested.",
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
};

const CHANGES: RepositoryChanges = {
  changes: [
    OPEN_CHANGE,
    {
      proposalId: "prp_done1",
      lineage: "ctx.scr.002-run-tests-before-a-pr",
      statement: "Run tests before a PR",
      why: "CI is the gate, not the first reviewer.",
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

/** The signed-in person the denied state names, as the route resolves them. */
const VIEWER = {
  name: "Mac Anderson",
  email: "mac@acme.test",
  role: "workspace.viewer",
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
        orgName="Acme"
        wsName="Core platform"
        view={{ tab, change: null }}
        viewer={VIEWER}
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
  actions.readWorkingCopies.mockResolvedValue({
    ok: true,
    value: { workingCopies: [] },
  });
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

/** The row the Repositories table draws for one repository, by its full name. */
function repoRow(fullName: string) {
  return screen.getByTestId(`repository-row-${fullName}`);
}

/** Opens the repository dialog on one row, once its tree has been read. */
async function openRepository(
  user: ReturnType<typeof userEvent.setup>,
  fullName: string,
) {
  await waitFor(() => {
    expect(within(repoRow(fullName)).queryByText("reading")).toBeNull();
  });
  await user.click(repoRow(fullName));
  return screen.findByTestId("repository-dialog");
}

describe("states", () => {
  it("shows the skeleton while the list is read, never zeros, and no table until it answers", async () => {
    let answer!: (value: unknown) => void;
    actions.readWorkspaceRepositories.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    page();
    expect(screen.getByTestId("repositories-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("repositories-page").dataset.state).toBe(
      "loading",
    );
    expect(screen.queryByRole("table")).toBeNull();
    answer({ ok: true, value: { repositories: [MAIN] } });
    expect(
      await screen.findByRole("table", {
        name: "Repositories this workspace can see",
      }),
    ).toBeTruthy();
  });

  it("draws the loaded page: eyebrow, h1, one gold action, four tabs with live counts", async () => {
    const { root } = await loaded();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Repositories",
    );
    expect(screen.getByText("Core platform")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Repository views" });
    await waitFor(() => {
      expect(
        within(tabs)
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual([
        "Repositories2",
        "Working copies",
        "Changes1",
        "Configuration",
      ]);
    });
    const gold = screen.getByTestId("repositories-add-oxagen");
    expect(gold.className).toContain("bg-button-primary-bg");
    // Exactly one gold action on the screen: the panel's and the rows' Add
    // Oxagen are the small secondary beside the header's.
    await within(repoRow("acme/platform")).findByText("governed");
    expect(
      Array.from(root.querySelectorAll("button, a")).filter((el) =>
        el.className.includes("bg-button-primary-bg"),
      ),
    ).toEqual([gold]);
    await expectNoAxe(root);
  });

  it("is the empty state, whose one gold action opens the init wizard, when nothing is bound", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [] },
    });
    const user = userEvent.setup();
    page();
    const empty = await screen.findByTestId("repositories-empty");
    expect(empty).toHaveTextContent("This workspace has no repository yet");
    expect(screen.queryByTestId("repositories-add-oxagen")).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Repository views" }),
    ).toBeNull();
    await expectNoAxe(empty);
    await user.click(within(empty).getByTestId("repositories-empty-add"));
    expect(await screen.findByTestId("init-wizard")).toBeTruthy();
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
      `${VIEWER.name} · ${VIEWER.role}`,
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
        name: "Repositories this workspace can see",
      });
      const targets = phone.container.querySelectorAll("[data-touch-target]");
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets)
        expect(getComputedStyle(target).minHeight).toBe("44px");
    } finally {
      phone.restore();
    }
  });
});

describe("the Repositories tab", () => {
  it("lists main, then linked, then what the installation reaches and nobody bound, with the tree read per bound row", async () => {
    await loaded();
    const table = screen.getByRole("table", {
      name: "Repositories this workspace can see",
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
    expect(
      Array.from(table.querySelectorAll("tbody tr")).map((tr) =>
        tr.getAttribute("data-role"),
      ),
    ).toEqual(["main", "linked", "available"]);
    const main = repoRow("acme/platform");
    expect(await within(main).findByText("governed")).toBeTruthy();
    expect(main).toHaveTextContent("2 files");
    expect(main).toHaveTextContent("App installed");
    expect(main).toHaveTextContent("not recorded");
    const linked = repoRow("acme/docs-site");
    expect(await within(linked).findByText("no .oxagen/")).toBeTruthy();
    expect(linked).toHaveTextContent("App suspended");
    // The installation reaches acme/platform too; it is drawn once, as main.
    expect(screen.getAllByText("acme/platform")).toHaveLength(1);
    const available = repoRow("acme/infra");
    expect(available).toHaveTextContent("not linked");
    expect(available).toHaveTextContent("private");
    expect(actions.readRepositoryTree).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
    );
    // A repository nobody bound has no binding to read its tree through.
    expect(actions.readRepositoryTree).toHaveBeenCalledTimes(2);
  });

  it("warns that a linked repository with no .oxagen/ is steered by the main repo alone", async () => {
    await loaded();
    const banner = await screen.findByTestId("repositories-ungoverned");
    expect(banner).toHaveTextContent("acme/docs-site");
  });

  it("opens a repository's dialog from its name by keyboard, the row taking no role of its own", async () => {
    const { user } = await loaded();
    const row = repoRow("acme/docs-site");
    expect(row).not.toHaveAttribute("role");
    const name = within(row).getByRole("button", {
      name: "Open acme/docs-site",
    });
    name.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("repository-dialog")).toHaveTextContent(
      "linked repo",
    );
  });

  it("unlinks a linked repository from its dialog, and never offers it on main", async () => {
    const { user } = await loaded();
    const mainDialog = await openRepository(user, "acme/platform");
    expect(
      within(mainDialog).queryByTestId("repository-dialog-unlink"),
    ).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("repository-dialog")).toBeNull();
    });
    actions.unlinkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_link01",
        fullName: "acme/docs-site",
        unlinkedAt: "2026-09-19T10:00:00.000Z",
      },
    });
    const dialog = await openRepository(user, "acme/docs-site");
    await user.click(within(dialog).getByTestId("repository-dialog-unlink"));
    const confirm = await screen.findByTestId("unlink-dialog");
    expect(confirm).toHaveTextContent(
      "Unlink acme/docs-site from Core platform?",
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
    expect(await screen.findByTestId("repositories-notice")).toHaveTextContent(
      "acme/docs-site unlinked from Core platform.",
    );
    await waitFor(() => {
      expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(2);
    });
  });

  it("prints the unlink refusal in the confirm and keeps it open (negative)", async () => {
    const { user } = await loaded();
    actions.unlinkWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "repository_not_linked",
    });
    const dialog = await openRepository(user, "acme/docs-site");
    await user.click(within(dialog).getByTestId("repository-dialog-unlink"));
    const confirm = await screen.findByTestId("unlink-dialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Unlink it" }),
    );
    expect(
      await within(confirm).findByTestId("unlink-failure"),
    ).toHaveTextContent("no longer linked");
    expect(screen.queryByTestId("repositories-notice")).toBeNull();
  });

  it("links a repository the installation reaches from its dialog", async () => {
    const { user } = await loaded();
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_new01",
        fullName: "acme/infra",
        defaultRef: "main",
        linkedAt: "2026-09-19T10:00:00.000Z",
      },
    });
    const dialog = await openRepository(user, "acme/infra");
    expect(dialog).toHaveTextContent("not linked to this workspace");
    expect(within(dialog).queryByTestId("repository-dialog-unlink")).toBeNull();
    await user.click(within(dialog).getByTestId("repository-dialog-link"));
    await waitFor(() => {
      expect(actions.linkWorkspaceRepository).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { owner: "acme", name: "infra" },
      );
    });
    expect(
      await within(dialog).findByTestId("repository-dialog-linked"),
    ).toHaveTextContent("acme/infra linked to Core platform.");
  });

  it("prints a link refusal in the dialog and writes nothing else (negative)", async () => {
    const { user } = await loaded();
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "repository_linked_elsewhere",
    });
    const dialog = await openRepository(user, "acme/infra");
    await user.click(within(dialog).getByTestId("repository-dialog-link"));
    expect(
      await within(dialog).findByTestId("repository-dialog-failure"),
    ).toHaveTextContent("Another workspace has linked");
    expect(within(dialog).queryByTestId("repository-dialog-linked")).toBeNull();
    expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(1);
  });

  it("draws no not-linked rows and no unread note when GitHub is not connected (negative)", async () => {
    actions.listInstallationRepositories.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    await loaded();
    await waitFor(() => {
      expect(actions.listInstallationRepositories).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("repository-row-acme/infra")).toBeNull();
    expect(screen.queryByTestId("repositories-reachable-note")).toBeNull();
  });

  it("says only bound repositories are shown when the installation could not be listed (negative)", async () => {
    actions.listInstallationRepositories.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "installation_unreachable",
    });
    await loaded();
    expect(
      await screen.findByTestId("repositories-reachable-note"),
    ).toHaveTextContent("only bound ones are shown");
    expect(screen.queryByTestId("repository-row-acme/infra")).toBeNull();
  });
});

describe("the Repositories tab's edges", () => {
  it("says no rows match a search that finds nothing, and names a retired connection", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [{ ...MAIN, connectionLive: false }, LINKED] },
    });
    const { user } = await loaded();
    expect(
      screen.getByTestId("repository-retired-acme/platform"),
    ).toHaveTextContent("Connection retired");
    await user.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "no-such-repository",
    );
    expect(screen.getByTestId("repositories-table")).toHaveTextContent(
      "No rows match.",
    );
  });

  it("says when the installation reaches more than the list holds", async () => {
    actions.listInstallationRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [], truncated: true },
    });
    await loaded();
    expect(
      await screen.findByTestId("repositories-reachable-note"),
    ).toHaveTextContent("reaches more repositories than this list holds");
  });

  it("opens the wizard on a row's own Add Oxagen without opening its dialog", async () => {
    const { user } = await loaded();
    await within(repoRow("acme/docs-site")).findByText("no .oxagen/");
    await user.click(screen.getByTestId("repository-add-acme/docs-site"));
    const wizard = await screen.findByTestId("init-wizard");
    expect(
      within(wizard).getByTestId<HTMLSelectElement>("init-wizard-select").value,
    ).toBe("acme/docs-site");
    expect(screen.queryByTestId("repository-dialog")).toBeNull();
  });
});

describe("the repository dialog", () => {
  it("shows the production branch at its head, what .oxagen/ holds, and the unrecorded facts", async () => {
    const { user } = await loaded();
    const dialog = await openRepository(user, "acme/platform");
    expect(
      within(dialog).getByTestId("repository-dialog-branch"),
    ).toHaveTextContent("main at 0123456");
    // GitHub's default is the production branch, so there is nothing to offer.
    expect(
      within(dialog).queryByTestId("repository-dialog-branch-moved"),
    ).toBeNull();
    expect(
      within(dialog).getByTestId("repository-dialog-tree"),
    ).toHaveTextContent("governed");
    expect(dialog).toHaveTextContent("not recorded");
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
    const dialog = await openRepository(user, "acme/docs-site");
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
    // The dialog follows the repository by name rather than closing on the old binding.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("repository-dialog")).getByTestId(
          "repository-dialog-branch",
        ),
      ).toHaveTextContent("main");
    });
    expect(actions.setProductionBranch).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
      "main",
    );
  });

  it("prints branch_not_found and writes nothing else (negative)", async () => {
    const { user } = await loaded();
    const dialog = await openRepository(user, "acme/platform");
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
    expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(1);
  });
  it("says a tree that could not be read, and that a branch set to itself wrote nothing", async () => {
    actions.readRepositoryTree.mockImplementation(
      (_org: string, _ws: string, bindingId: string) =>
        Promise.resolve(
          bindingId === MAIN.bindingId
            ? {
                ok: true,
                value: {
                  ...MAIN_TREE,
                  initPullRequest: {
                    number: 9,
                    htmlUrl: "https://github.com/acme/platform/pull/9",
                  },
                },
              }
            : { ok: false, reason: "unavailable", code: "github_down" },
        ),
    );
    const { user } = await loaded();
    const linked = await openRepository(user, "acme/docs-site");
    expect(
      within(linked).getByTestId("repository-dialog-tree-failure"),
    ).toHaveTextContent("github_down");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("repository-dialog")).toBeNull();
    });
    const main = await openRepository(user, "acme/platform");
    expect(
      within(main).getByTestId("repository-dialog-init-pr"),
    ).toHaveTextContent("Pull request #9 adds .oxagen/");
    actions.setProductionBranch.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_main01",
        fullName: "acme/platform",
        productionBranch: "main",
        previousBranch: "main",
        changed: false,
      },
    });
    await user.type(
      within(main).getByTestId("repository-dialog-branch-input"),
      "main",
    );
    await user.click(
      within(main).getByRole("button", { name: "Set production branch" }),
    );
    expect(
      await within(main).findByTestId("repository-dialog-branch-done"),
    ).toHaveTextContent(
      "main is already the production branch. Nothing was written.",
    );
    expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(1);
  });

  it("goes to the Changes tab from a governed repository's See its changes", async () => {
    const { user } = await loaded();
    const dialog = await openRepository(user, "acme/platform");
    await user.click(within(dialog).getByTestId("repository-dialog-changes"));
    expect(nav.push).toHaveBeenCalledWith(
      "/acme/core-platform/repositories/changes",
    );
  });

  it("carries the repair on a main repository whose connection was retired", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [{ ...MAIN, connectionLive: false }] },
    });
    const { user } = await loaded();
    const dialog = await openRepository(user, "acme/platform");
    expect(await within(dialog).findByTestId("repository-setup")).toBeTruthy();
  });
});

describe("the init wizard", () => {
  it("walks five steps and opens the pull request with both reviewed files", async () => {
    const { user } = await loaded();
    await within(repoRow("acme/docs-site")).findByText("no .oxagen/");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    const steps = within(wizard).getByRole("list", { name: "Steps" });
    expect(
      within(steps)
        .getAllByRole("listitem")
        .map((s) => s.textContent),
    ).toEqual([
      "1Repository",
      "2Branch & governance",
      "3Permissions",
      "4Review",
      "5Pull request",
    ]);
    expect(within(steps).getAllByRole("listitem")[0]).toHaveAttribute(
      "aria-current",
      "step",
    );

    // Only the repositories with no .oxagen/ are offered: the linked one whose
    // tree read empty, and the one the installation reaches unbound.
    const select =
      within(wizard).getByTestId<HTMLSelectElement>("init-wizard-select");
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "acme/docs-site",
      "acme/infra",
    ]);
    expect(select.value).toBe("acme/docs-site");
    expect(
      within(wizard).getByTestId("init-wizard-role-note"),
    ).toHaveTextContent(
      "acme/platform is already this workspace’s main repo, so this one is linked.",
    );
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const branch = within(wizard).getByTestId("init-wizard-branch");
    expect(
      within(branch).getByTestId<HTMLInputElement>("init-wizard-branch-input")
        .value,
    ).toBe("trunk");
    expect(branch).toHaveTextContent(
      "GitHub’s default branch is main, which is the suggestion and not the decision.",
    );
    await user.click(within(branch).getByRole("radio", { name: /regulated/ }));
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const permissions = within(wizard).getByTestId("init-wizard-permissions");
    const table = within(permissions).getByRole("table", {
      name: "GitHub App permissions",
    });
    expect(table).toHaveTextContent("Contentsread and write");
    expect(table).toHaveTextContent("Pull requestsread and write");
    expect(table).toHaveTextContent("Checkswrite");
    expect(
      within(permissions).getByTestId("init-wizard-cannot"),
    ).toHaveTextContent("push to trunk");
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const governance = within(wizard).getByTestId<HTMLTextAreaElement>(
      "init-wizard-governance-toml",
    );
    expect(governance.value).toContain('mode = "regulated"');
    const workspace = within(wizard).getByTestId<HTMLTextAreaElement>(
      "init-wizard-workspace-toml",
    );
    expect(workspace.value).toContain('name = "acme/docs-site"');
    expect(workspace.value).toContain('role = "linked"');
    await user.type(workspace, "# reviewed");
    await user.click(within(wizard).getByTestId("init-wizard-next"));

    const pr = within(wizard).getByTestId("init-wizard-pull-request");
    expect(within(pr).getByTestId("init-wizard-pr-head")).toHaveTextContent(
      "acme/docs-site←oxagen/init",
    );
    expect(within(pr).getByTestId("init-wizard-files")).toHaveTextContent(
      ".gitignore",
    );
    expect(within(pr).getByTestId("init-wizard-checks")).toHaveTextContent(
      "No .oxagen/ exists on trunk.",
    );
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
    expect(opened).toHaveTextContent("Opened acme/docs-site#7 · Add Oxagen");
    expect(within(opened).getByTestId("init-wizard-pr-link")).toHaveAttribute(
      "href",
      "https://github.com/acme/docs-site/pull/7",
    );
    // The repository was already bound and its branch unchanged, so the pull
    // request is the one write.
    expect(actions.linkWorkspaceRepository).not.toHaveBeenCalled();
    expect(actions.setProductionBranch).not.toHaveBeenCalled();
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

  it("links a repository nobody bound before it opens the pull request", async () => {
    const { user } = await loaded();
    await within(repoRow("acme/docs-site")).findByText("no .oxagen/");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    await user.selectOptions(
      within(wizard).getByTestId("init-wizard-select"),
      "acme/infra",
    );
    for (let i = 0; i < 4; i += 1)
      await user.click(within(wizard).getByTestId("init-wizard-next"));
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_new01",
        fullName: "acme/infra",
        defaultRef: "main",
        linkedAt: "2026-09-19T10:00:00.000Z",
      },
    });
    actions.openInitPullRequest.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        branch: "oxagen/init",
        base: "main",
        pullRequest: {
          number: 8,
          htmlUrl: "https://github.com/acme/infra/pull/8",
        },
        files: [".oxagen/workspace.toml", ".oxagen/rules/governance.toml"],
        reused: false,
      },
    });
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    expect(
      await within(wizard).findByTestId("init-wizard-opened"),
    ).toHaveTextContent("Opened acme/infra#8");
    expect(actions.linkWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "infra" },
    );
    expect(actions.openInitPullRequest.mock.calls[0]?.[2]).toMatchObject({
      bindingId: "rpb_new01",
      governanceMode: "team",
    });
  });

  it("prints a refusal and stays on the last step (negative)", async () => {
    const { user } = await loaded();
    const dialog = await openRepository(user, "acme/docs-site");
    await user.click(
      within(dialog).getByTestId("repository-dialog-add-oxagen"),
    );
    const wizard = await screen.findByTestId("init-wizard");
    // Opened from a repository, the wizard starts with that one picked.
    expect(
      within(wizard).getByTestId<HTMLSelectElement>("init-wizard-select").value,
    ).toBe("acme/docs-site");
    for (let i = 0; i < 4; i += 1)
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
    expect(within(wizard).queryByTestId("init-wizard-opened")).toBeNull();
  });

  it("refuses an empty production branch, and Back returns to the repository step (negative)", async () => {
    const { user } = await loaded();
    await within(repoRow("acme/docs-site")).findByText("no .oxagen/");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    await user.click(within(wizard).getByTestId("init-wizard-next"));
    await user.clear(within(wizard).getByTestId("init-wizard-branch-input"));
    await user.click(within(wizard).getByTestId("init-wizard-next"));
    expect(within(wizard).getByTestId("init-wizard-failure")).toHaveTextContent(
      "Name the production branch first.",
    );
    expect(within(wizard).getByTestId("init-wizard-branch")).toBeTruthy();
    await user.click(within(wizard).getByTestId("init-wizard-back"));
    expect(within(wizard).getByTestId("init-wizard-repository")).toBeTruthy();
    expect(within(wizard).queryByTestId("init-wizard-failure")).toBeNull();
  });

  it("moves the production branch first when the person changed it, and stops on that refusal (negative)", async () => {
    const { user } = await loaded();
    await within(repoRow("acme/docs-site")).findByText("no .oxagen/");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    await user.click(within(wizard).getByTestId("init-wizard-next"));
    const input = within(wizard).getByTestId("init-wizard-branch-input");
    await user.clear(input);
    await user.type(input, "release");
    for (let i = 0; i < 3; i += 1)
      await user.click(within(wizard).getByTestId("init-wizard-next"));
    expect(within(wizard).getByTestId("init-wizard-checks")).toHaveTextContent(
      "No .oxagen/ exists on release.",
    );
    actions.setProductionBranch.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "branch_not_found",
    });
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    expect(
      await within(wizard).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("GitHub has no branch by that name");
    expect(actions.setProductionBranch).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
      "release",
    );
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
  });

  it("binds the main repository first when the workspace has none, and says when the pull request already existed", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [] },
    });
    const user = userEvent.setup();
    page();
    const empty = await screen.findByTestId("repositories-empty");
    await user.click(within(empty).getByTestId("repositories-empty-add"));
    const wizard = await screen.findByTestId("init-wizard");
    await waitFor(() => {
      expect(
        Array.from(
          within(wizard).getByTestId<HTMLSelectElement>("init-wizard-select")
            .options,
        ).map((o) => o.value),
      ).toEqual(["acme/platform", "acme/infra"]);
    });
    await user.selectOptions(
      within(wizard).getByTestId("init-wizard-select"),
      "acme/infra",
    );
    expect(
      within(wizard).getByTestId("init-wizard-role-note"),
    ).toHaveTextContent("acme/infra is this workspace’s main repo.");
    for (let i = 0; i < 4; i += 1)
      await user.click(within(wizard).getByTestId("init-wizard-next"));
    actions.bindWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: BOUND_SETUP,
    });
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: {
        repositories: [
          {
            ...MAIN,
            bindingId: "rpb_infra1",
            name: "infra",
            fullName: "acme/infra",
            htmlUrl: "https://github.com/acme/infra",
          },
        ],
      },
    });
    actions.openInitPullRequest.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        branch: "oxagen/init",
        base: "main",
        pullRequest: {
          number: 3,
          htmlUrl: "https://github.com/acme/infra/pull/3",
        },
        files: [".oxagen/workspace.toml", ".oxagen/rules/governance.toml"],
        reused: true,
      },
    });
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    expect(
      await within(wizard).findByTestId("init-wizard-opened"),
    ).toHaveTextContent(
      "acme/infra#3 already adds .oxagen/. Nothing new was pushed.",
    );
    expect(actions.bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "infra" },
    );
    expect(actions.openInitPullRequest.mock.calls[0]?.[2]).toMatchObject({
      bindingId: "rpb_infra1",
    });
    const sent: unknown = actions.openInitPullRequest.mock.calls[0]?.[2];
    expect(JSON.stringify(sent)).toContain('role = \\"main\\"');
  });

  it("stops when binding the main repository is refused, and says so (negative)", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [] },
    });
    const user = userEvent.setup();
    page();
    const empty = await screen.findByTestId("repositories-empty");
    await user.click(within(empty).getByTestId("repositories-empty-add"));
    const wizard = await screen.findByTestId("init-wizard");
    await waitFor(() => {
      expect(within(wizard).getByTestId("init-wizard-next")).toBeEnabled();
    });
    for (let i = 0; i < 4; i += 1)
      await user.click(within(wizard).getByTestId("init-wizard-next"));
    actions.bindWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "repository_linked_elsewhere",
    });
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    expect(
      await within(wizard).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("Another workspace has linked");
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
  });

  it("carries the GitHub connection on its first step when GitHub is not connected and nothing is offered", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [MAIN] },
    });
    actions.listInstallationRepositories.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    const { user } = await loaded();
    await within(repoRow("acme/platform")).findByText("governed");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    expect(within(wizard).getByTestId("init-wizard-connect")).toBeTruthy();
    expect(await within(wizard).findByTestId("repository-setup")).toBeTruthy();
    expect(within(wizard).getByTestId("init-wizard-next")).toBeDisabled();
  });

  it("reads a wizard write that never answered as a failure (negative)", async () => {
    const { user } = await loaded();
    await within(repoRow("acme/docs-site")).findByText("no .oxagen/");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    for (let i = 0; i < 4; i += 1)
      await user.click(within(wizard).getByTestId("init-wizard-next"));
    actions.openInitPullRequest.mockRejectedValue(new Error("network"));
    await user.click(within(wizard).getByTestId("init-wizard-open"));
    expect(
      await within(wizard).findByTestId("init-wizard-failure"),
    ).toBeTruthy();
  });

  it("says so when no repository is left to initialise (negative)", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [MAIN] },
    });
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
        ],
        truncated: false,
      },
    });
    const { user } = await loaded();
    await within(repoRow("acme/platform")).findByText("governed");
    await user.click(screen.getByTestId("repositories-add-oxagen"));
    const wizard = await screen.findByTestId("init-wizard");
    expect(
      within(wizard).getByTestId("init-wizard-no-candidates"),
    ).toBeTruthy();
    expect(within(wizard).getByTestId("init-wizard-next")).toBeDisabled();
  });
});

describe("the other tabs", () => {
  it("Working copies: the reported directories, the two files, and the gold moves to Connect a directory", async () => {
    actions.readWorkingCopies.mockResolvedValue({
      ok: true,
      value: {
        workingCopies: [
          {
            id: "wcp_laptop01",
            hostname: "mac-studio.local",
            directory: "/Users/mac/code/platform",
            repository: "acme/platform",
            branch: "main",
            headCommit: "0123456789abcdef",
            oxagenPresent: true,
            symlinks: "linked",
            pulledCommit: "0123456789abcdef",
            lastEvent: "pull",
            reportedBy: { userId: "usr_mac", name: "Mac Anderson" },
            cliVersion: "3.4.0",
            firstSeenAt: "2026-09-20T09:00:00.000Z",
            lastSeenAt: "2026-09-24T09:00:00.000Z",
          },
        ],
      },
    });
    const { user } = await loaded("working-copies");
    expect(screen.getByTestId("working-copies-panel")).toHaveTextContent(
      "A copy that is behind is not a run that is behind.",
    );
    expect(
      await screen.findByTestId("working-copy-wcp_laptop01"),
    ).toHaveTextContent("/Users/mac/code/platform");
    expect(actions.readWorkingCopies).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(screen.getByTestId("working-copies-files")).toHaveTextContent(
      "workspace.json",
    );
    expect(
      screen.getByTestId("repositories-add-oxagen").className,
    ).not.toContain("bg-button-primary-bg");
    const connect = screen.getByTestId("working-copies-connect");
    expect(connect.className).toContain("bg-button-primary-bg");
    await user.click(connect);
    const dialog = await screen.findByTestId("linkdir-dialog");
    expect(within(dialog).getByTestId("linkdir-command")).toHaveTextContent(
      "oxagen init --org acme --workspace core-platform",
    );
    expect(dialog).toHaveTextContent("Linking a directory grants nothing.");
    await expectNoAxe(dialog);
  });

  it("Working copies is read only on its own tab, and its retry reads it again", async () => {
    await loaded("repositories");
    expect(actions.readWorkingCopies).not.toHaveBeenCalled();
    cleanup();

    actions.readWorkingCopies.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "store_unreachable",
    });
    const { user } = await loaded("working-copies");
    expect(
      await screen.findByTestId("working-copies-failure"),
    ).toHaveTextContent("store_unreachable");
    await user.click(screen.getByTestId("working-copies-retry"));
    expect(await screen.findByTestId("working-copies-empty")).toBeTruthy();
    expect(actions.readWorkingCopies).toHaveBeenCalledTimes(2);
  });

  it("Changes: every Context PR with its kind, opener, state and checks; each opens on its own path", async () => {
    const { user } = await loaded("changes");
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
    const failed = screen.getByTestId("change-row-prp_open1");
    expect(failed).toHaveTextContent("checks failed");
    expect(failed).toHaveTextContent("3 / 6");
    expect(failed).toHaveTextContent("the promoter");
    expect(failed).toHaveTextContent("acme/platform#42");
    // A person's user id is said as a person, not printed.
    expect(screen.getByTestId("change-row-prp_done1")).toHaveTextContent(
      "a person",
    );
    await user.click(failed);
    expect(nav.push).toHaveBeenCalledWith(
      "/acme/core-platform/repositories/changes/prp_open1",
    );
    expect(screen.getByTestId("changes-auto")).toHaveTextContent(
      "Drift is reported, never repaired in place.",
    );
    await expectNoAxe(screen.getByTestId("changes"));
  });

  it("Changes: opens a change by keyboard, and says when a search matches none", async () => {
    actions.readRepositoryChanges.mockResolvedValue({
      ok: true,
      value: {
        open: 2,
        changes: [
          ...CHANGES.changes,
          {
            ...OPEN_CHANGE,
            proposalId: "prp_run1",
            lineage: "ctx.scr.003-running",
            status: "checks_running",
            checks: null,
          },
        ],
      },
    });
    const { user } = await loaded("changes");
    const running = await screen.findByTestId("change-row-prp_run1");
    expect(running.querySelector('[data-ci="running"]')).not.toBeNull();
    expect(running).toHaveTextContent("queued");
    expect(
      screen
        .getByTestId("change-row-prp_done1")
        .querySelector('[data-ci="passed"]'),
    ).not.toBeNull();
    screen.getByTestId("change-row-prp_open1").focus();
    await user.keyboard("{Enter}");
    expect(nav.push).toHaveBeenCalledWith(
      "/acme/core-platform/repositories/changes/prp_open1",
    );
    await user.type(
      within(screen.getByTestId("changes")).getByRole("searchbox"),
      "no-such-change",
    );
    expect(screen.getByTestId("changes-empty")).toHaveTextContent(
      "No rows match.",
    );
  });

  it("Changes: shows one change on its own path, and Back returns to the list", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "proposal_not_found",
    });
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <Repositories
          org="acme"
          ws="core-platform"
          orgName="Acme"
          wsName="Core platform"
          view={{ tab: "changes", change: "prp_open1" }}
          viewer={VIEWER}
        />
      </IntlProvider>,
    );
    const detail = await screen.findByTestId("change-detail");
    await user.click(within(detail).getByTestId("change-back"));
    expect(nav.push).toHaveBeenCalledWith(
      "/acme/core-platform/repositories/changes",
    );
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
    expect(
      screen.getByTestId("configuration-workspace-toml"),
    ).toHaveTextContent("On acme/platform at 0123456");
    expect(
      screen.getByTestId("configuration-workspace-toml"),
    ).toHaveTextContent('slug = "core-platform"');
    expect(screen.getByTestId("configuration-mode")).toHaveTextContent(
      "mode = team",
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
      "opening and merging are refused",
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
    expect(
      screen.getByTestId("configuration-workspace-toml"),
    ).toHaveTextContent("On acme/platform · not indexed yet");
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
        <Changes changes={{ kind: "loading" }} onOpen={() => {}} />
      </IntlProvider>,
    );
    expect(screen.getByTestId("changes-loading")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.queryByTestId("changes-empty")).toBeNull();
  });

  it("never draws the pull request URL as a link, and says unreported checks are queued", () => {
    const [change] = CHANGES.changes;
    if (change === undefined) throw new Error("Expected a change fixture");
    render(
      <IntlProvider>
        <Changes
          onOpen={() => {}}
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
    const row = screen.getByTestId("change-row-prp_open1");
    expect(row).toHaveTextContent("acme/platform#42");
    // The row opens the change on its own path; no URL from the record is
    // ever drawn as a link here.
    expect(row.querySelector("a")).toBeNull();
    expect(row).toHaveTextContent("queued");
    expect(row).not.toHaveTextContent("3 / 6");
  });
});

describe("one change on the Changes tab", () => {
  const CONTEXT_PR = {
    proposalId: "prp_open1",
    lineage: "ctx.scr.001-never-push-to-main",
    status: "checks_passed",
    governanceMode: "team",
    pr: {
      number: 42,
      url: "https://github.com/acme/platform/pull/42",
      repository: "acme/platform",
      baseRef: "main",
      branch: "oxagen/prp_open1",
      headSha: "0123456789abcdef",
    },
    body: null,
    checks: [{ name: "schema", status: "passed", summary: "It parses." }],
    onMerge: {
      path: ".oxagen/rules/ctx.scr.001-never-push-to-main.toml",
      bundleVersion: { current: 3, afterMerge: 4 },
    },
    merged: null,
  };

  function changePage(change: string) {
    return render(
      <IntlProvider>
        <Repositories
          org="acme"
          ws="core-platform"
          orgName="Acme"
          wsName="Core platform"
          view={{ tab: "changes", change }}
          viewer={VIEWER}
        />
      </IntlProvider>,
    );
  }

  it("opens the change with the list's row, hands the gold to Merge, and goes back to every change", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: CONTEXT_PR,
    });
    const user = userEvent.setup();
    changePage("prp_open1");
    const detail = await screen.findByTestId("change-detail");
    await within(detail).findByTestId("change-merge-steps");
    // The row the list holds supplies the opener and the why.
    await waitFor(() => {
      expect(within(detail).getByTestId("change-why")).toHaveTextContent(
        "Main is shared and contested.",
      );
    });
    const merge = within(detail).getByTestId("change-merge");
    expect(merge.className).toContain("bg-button-primary-bg");
    // Merge holds the screen's one gold, so the header's Add Oxagen does not.
    await waitFor(() => {
      expect(
        screen.getByTestId("repositories-add-oxagen").className,
      ).not.toContain("bg-button-primary-bg");
    });
    expect(actions.readRepositoryChange).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_open1",
    );
    await user.click(within(detail).getByTestId("change-back"));
    expect(nav.push).toHaveBeenCalledWith(
      "/acme/core-platform/repositories/changes",
    );
  });

  it("re-reads the page after a merge", async () => {
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: CONTEXT_PR,
    });
    actions.mergeRepositoryChange.mockResolvedValue({
      ok: true,
      value: { commit: "fedcba9876543210" },
    });
    const user = userEvent.setup();
    changePage("prp_open1");
    const detail = await screen.findByTestId("change-detail");
    await user.click(await within(detail).findByTestId("change-merge"));
    await waitFor(() => {
      expect(actions.readWorkspaceRepositories).toHaveBeenCalledTimes(2);
    });
    expect(actions.readRepositoryChanges).toHaveBeenCalledTimes(2);
  });

  it("opens a change the list does not hold, with no row behind it (negative)", async () => {
    actions.readRepositoryChanges.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "github_down",
    });
    actions.readRepositoryChange.mockResolvedValue({
      ok: true,
      value: CONTEXT_PR,
    });
    changePage("prp_open1");
    const detail = await screen.findByTestId("change-detail");
    await within(detail).findByTestId("change-merge-steps");
    expect(within(detail).getByTestId("change-why")).toHaveTextContent(
      "not recorded",
    );
    expect(within(detail).getByRole("heading", { level: 2 })).toHaveTextContent(
      "ctx.scr.001-never-push-to-main",
    );
  });
});

describe("page reads", () => {
  // A Context PR can merge or close on GitHub at any moment, and the
  // repository sync moves it within seconds (ADR-184). The list re-reads
  // while one is open, so the new state shows without a reload.
  it("re-reads the changes every ten seconds while a Context PR is open", async () => {
    const every = vi.spyOn(window, "setInterval");
    page();
    await waitFor(() => {
      expect(every).toHaveBeenCalledWith(expect.any(Function), 10_000);
    });
    const poll = every.mock.calls.find(([, ms]) => ms === 10_000);
    if (!poll) throw new Error("no ten-second poll was scheduled");
    const tick = poll[0];
    if (typeof tick !== "function")
      throw new Error("the poll is not a function");
    const before = actions.readRepositoryChanges.mock.calls.length;
    tick();
    await waitFor(() => {
      expect(actions.readRepositoryChanges).toHaveBeenCalledTimes(before + 1);
    });
    every.mockRestore();
  });

  it("does not poll when no Context PR is open", async () => {
    actions.readRepositoryChanges.mockResolvedValue({
      ok: true,
      value: { changes: [], open: 0 },
    });
    const every = vi.spyOn(window, "setInterval");
    page();
    await waitFor(() => {
      expect(actions.readRepositoryChanges).toHaveBeenCalled();
    });
    expect(every).not.toHaveBeenCalledWith(expect.any(Function), 10_000);
    every.mockRestore();
  });

  it("draws nothing from answers that land after the page left the screen", async () => {
    let answerList!: (value: unknown) => void;
    let answerChanges!: (value: unknown) => void;
    actions.readWorkspaceRepositories.mockReturnValue(
      new Promise((resolve) => {
        answerList = resolve;
      }),
    );
    actions.readRepositoryChanges.mockReturnValue(
      new Promise((resolve) => {
        answerChanges = resolve;
      }),
    );
    const view = page();
    view.unmount();
    answerChanges({ ok: true, value: CHANGES });
    answerList({ ok: true, value: { repositories: [MAIN] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId("repositories-page")).toBeNull();
    // The unmounted page asked for no tree: the list answered too late.
    expect(actions.readRepositoryTree).not.toHaveBeenCalled();
  });

  it("names the call as unanswered when the list read throws (negative)", async () => {
    actions.readWorkspaceRepositories.mockRejectedValue(new Error("offline"));
    page();
    expect(await screen.findByTestId("repositories-error")).toHaveTextContent(
      "action_failed",
    );
  });

  it("says the workspace binds no main repository on Configuration when only linked ones are bound", async () => {
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [LINKED] },
    });
    await loaded("configuration");
    expect(
      await screen.findByTestId("configuration-no-main"),
    ).toHaveTextContent("binds no main repository");
  });
});
