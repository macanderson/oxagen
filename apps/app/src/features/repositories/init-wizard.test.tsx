// @vitest-environment jsdom
// The init wizard on its own, over the paths the page test does not walk: a
// workspace with no main repository binds the repository first and finds its
// binding in the list, a production branch changed on step 2 is written
// before the pull request, every write on the way can refuse, and a pull
// request that already existed is said to be reused.
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
import { IntlProvider } from "@/test/intl";
import type { RepositoryRow } from "./view";

const actions = vi.hoisted(() => ({
  linkWorkspaceRepository: vi.fn(),
  bindWorkspaceRepository: vi.fn(),
  readWorkspaceRepositories: vi.fn(),
  setProductionBranch: vi.fn(),
  openInitPullRequest: vi.fn(),
  readWorkspaceRepository: vi.fn(),
  listInstallationRepositories: vi.fn(),
  listGithubInstallations: vi.fn(),
  attachGithubInstallation: vi.fn(),
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

const { InitWizard } = await import("./init-wizard");

/** A repository the installation reaches that this workspace does not bind. */
const AVAILABLE: RepositoryRow = {
  fullName: "acme/infra",
  owner: "acme",
  name: "infra",
  role: "available",
  bindingId: null,
  productionBranch: "main",
  visibility: "private",
  htmlUrl: "https://github.com/acme/infra",
  events: null,
  connectionLive: true,
  tree: null,
};

const MAIN: RepositoryRow = {
  ...AVAILABLE,
  fullName: "acme/platform",
  name: "platform",
  role: "main",
  bindingId: "rpb_main01",
  events: "installed",
  tree: { kind: "loading" },
};

const OPENED = {
  ok: true,
  value: {
    fullName: "acme/infra",
    branch: "oxagen/init",
    base: "release",
    pullRequest: {
      number: 9,
      htmlUrl: "https://github.com/acme/infra/pull/9",
    },
    files: [".oxagen/workspace.toml"],
    reused: false,
  },
};

const onClose = vi.fn();
const onOpened = vi.fn();

function wizard(rows: RepositoryRow[], connectNeeded = false) {
  render(
    <IntlProvider>
      <InitWizard
        org="acme"
        ws="core-platform"
        wsName="Core platform"
        open
        initial={null}
        rows={rows}
        connectNeeded={connectNeeded}
        onClose={onClose}
        onOpened={onOpened}
      />
    </IntlProvider>,
  );
  return screen.getByTestId("init-wizard");
}

/** Walks from step 1 to the pull request step, typing a branch on step 2. */
async function toLastStep(
  user: ReturnType<typeof userEvent.setup>,
  root: HTMLElement,
  branch?: string,
) {
  await user.click(within(root).getByTestId("init-wizard-next"));
  if (branch !== undefined) {
    const input = within(root).getByTestId("init-wizard-branch-input");
    await user.clear(input);
    await user.type(input, branch);
  }
  for (let i = 0; i < 3; i += 1)
    await user.click(within(root).getByTestId("init-wizard-next"));
  expect(within(root).getByTestId("init-wizard-pull-request")).toBeTruthy();
}

beforeEach(() => {
  for (const fn of [...Object.values(actions), onClose, onOpened])
    fn.mockReset();
  actions.readWorkspaceRepository.mockReturnValue(new Promise(() => {}));
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the init wizard", () => {
  it("binds the repository as main when the workspace has none, finds its binding, moves the branch, then opens the pull request", async () => {
    actions.bindWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        defaultRef: "main",
        boundAt: "2026-09-19T10:00:00.000Z",
      },
    });
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: {
        repositories: [
          { fullName: "ACME/Infra", bindingId: "rpb_new01", role: "main" },
        ],
      },
    });
    actions.setProductionBranch.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_new02",
        fullName: "acme/infra",
        productionBranch: "release",
        previousBranch: "main",
        changed: true,
      },
    });
    actions.openInitPullRequest.mockResolvedValue({
      ...OPENED,
      value: { ...OPENED.value, reused: true },
    });
    const user = userEvent.setup();
    const root = wizard([AVAILABLE]);
    expect(within(root).getByTestId("init-wizard-role-note")).toHaveTextContent(
      "acme/infra is this workspace’s main repo.",
    );
    await toLastStep(user, root, "release");
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-opened"),
    ).toHaveTextContent(
      "acme/infra#9 already adds .oxagen/. Nothing new was pushed.",
    );
    expect(actions.bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "infra" },
    );
    expect(actions.linkWorkspaceRepository).not.toHaveBeenCalled();
    expect(actions.setProductionBranch).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_new01",
      "release",
    );
    expect(actions.openInitPullRequest.mock.calls[0]?.[2]).toMatchObject({
      bindingId: "rpb_new01",
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("prints the bind's refusal and writes nothing else (negative)", async () => {
    actions.bindWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "main_repo_claimed",
    });
    const user = userEvent.setup();
    const root = wizard([AVAILABLE]);
    await toLastStep(user, root);
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("Another workspace steers by that repository");
    expect(actions.readWorkspaceRepositories).not.toHaveBeenCalled();
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("prints the list's refusal after the bind, and re-reads the page for the bind it did write (negative)", async () => {
    actions.bindWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        defaultRef: "main",
        boundAt: "2026-09-19T10:00:00.000Z",
      },
    });
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "github_down",
    });
    const user = userEvent.setup();
    const root = wizard([AVAILABLE]);
    await toLastStep(user, root);
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("github_down");
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    // The bind was written, so the page re-reads even though the wizard
    // stops: otherwise the table still offers the repository as not linked.
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("says the repository is not linked when the list does not hold the one it just bound (negative)", async () => {
    actions.bindWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        defaultRef: "main",
        boundAt: "2026-09-19T10:00:00.000Z",
      },
    });
    actions.readWorkspaceRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [] },
    });
    const user = userEvent.setup();
    const root = wizard([AVAILABLE]);
    await toLastStep(user, root);
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("Reload the page");
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("prints the link's refusal when the workspace already has a main repository (negative)", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "repository_linked_elsewhere",
    });
    const user = userEvent.setup();
    const root = wizard([MAIN, AVAILABLE]);
    await toLastStep(user, root);
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("Another workspace has linked");
    expect(actions.bindWorkspaceRepository).not.toHaveBeenCalled();
  });

  it("prints the branch write's refusal and opens no pull request (negative)", async () => {
    actions.setProductionBranch.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "branch_not_found",
    });
    const user = userEvent.setup();
    const bound: RepositoryRow = {
      ...AVAILABLE,
      role: "linked",
      bindingId: "rpb_link01",
      tree: {
        kind: "ready",
        value: {
          bindingId: "rpb_link01",
          role: "linked",
          fullName: "acme/infra",
          productionBranch: "main",
          githubDefaultBranch: "main",
          head: "0123456789abcdef0123",
          oxagen: { present: false, files: [] },
          workspaceToml: null,
          governanceToml: null,
          governanceMode: "absent",
          initPullRequest: null,
          readAt: "2026-09-19T10:00:00.000Z",
        },
      },
    };
    const root = wizard([MAIN, bound]);
    await toLastStep(user, root, "nope");
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-failure"),
    ).toHaveTextContent("Check the spelling");
    expect(actions.linkWorkspaceRepository).not.toHaveBeenCalled();
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("refuses to leave step 2 with no production branch, and goes back a step (negative)", async () => {
    const user = userEvent.setup();
    const root = wizard([AVAILABLE]);
    await user.click(within(root).getByTestId("init-wizard-next"));
    await user.clear(within(root).getByTestId("init-wizard-branch-input"));
    await user.click(within(root).getByTestId("init-wizard-next"));
    expect(within(root).getByTestId("init-wizard-failure")).toHaveTextContent(
      "Name the production branch first.",
    );
    expect(within(root).getByTestId("init-wizard-branch")).toBeTruthy();
    await user.click(within(root).getByTestId("init-wizard-back"));
    expect(within(root).getByTestId("init-wizard-repository")).toBeTruthy();
    expect(within(root).queryByTestId("init-wizard-failure")).toBeNull();
  });

  it("carries the GitHub connection on step 1 when nothing can be offered until it exists", () => {
    const root = wizard([], true);
    expect(within(root).getByTestId("init-wizard-connect")).toHaveTextContent(
      "This workspace binds no main repo yet.",
    );
    expect(within(root).getByTestId("repository-setup")).toBeTruthy();
    expect(within(root).getByTestId("init-wizard-next")).toBeDisabled();
  });

  it("closes from Cancel on the first step", async () => {
    const user = userEvent.setup();
    const root = wizard([AVAILABLE]);
    await user.click(within(root).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
