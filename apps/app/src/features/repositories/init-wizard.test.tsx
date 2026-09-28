// @vitest-environment jsdom
// The init wizard on its own, over the paths the page test does not walk: a
// bound repository whose production branch changed on step 2 has the branch
// written before the pull request, every write on the way can refuse, and a
// pull request that already existed is said to be reused. A repository with
// no binding is linked: the wizard proposes the link as a steering PR
// (ADR-212) and stops there, with no branch move and no pull request until the
// PR merges. The wizard offers no main repository choice, because Oxagen
// creates the steering repository when it provisions the workspace.
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
  setProductionBranch: vi.fn(),
  openInitPullRequest: vi.fn(),
  readWorkspaceRepository: vi.fn(),
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

/** A production branch that reads and holds no `.oxagen/`. */
function absentTree(
  bindingId: string,
  role: "main" | "linked",
  fullName: string,
): RepositoryRow["tree"] {
  return {
    kind: "ready",
    value: {
      bindingId,
      role,
      fullName,
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
  };
}

/** A linked repository this workspace binds, with no `.oxagen/` on its branch. */
const BOUND_LINKED: RepositoryRow = {
  ...AVAILABLE,
  role: "linked",
  bindingId: "rpb_link01",
  tree: absentTree("rpb_link01", "linked", "acme/infra"),
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
  it("moves the branch of a bound repository, then opens the pull request", async () => {
    actions.setProductionBranch.mockResolvedValue({
      ok: true,
      value: {
        bindingId: "rpb_link02",
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
    const root = wizard([MAIN, BOUND_LINKED]);
    expect(within(root).getByTestId("init-wizard-role-note")).toHaveTextContent(
      "acme/infra is linked to this workspace.",
    );
    await toLastStep(user, root, "release");
    await user.click(within(root).getByTestId("init-wizard-open"));
    expect(
      await within(root).findByTestId("init-wizard-opened"),
    ).toHaveTextContent(
      "acme/infra#9 already adds .oxagen/. Nothing new was pushed.",
    );
    expect(actions.linkWorkspaceRepository).not.toHaveBeenCalled();
    expect(actions.setProductionBranch).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "rpb_link01",
      "release",
    );
    expect(actions.openInitPullRequest.mock.calls[0]?.[2]).toMatchObject({
      bindingId: "rpb_link01",
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("says a repository with no binding is linked by a steering PR, and offers no role choice", () => {
    const root = wizard([AVAILABLE]);
    expect(within(root).getByTestId("init-wizard-role-note")).toHaveTextContent(
      "acme/infra is not linked yet, so the wizard opens a steering PR that links it and stops there.",
    );
    expect(root.querySelector("[data-role]")).toBeNull();
    expect(within(root).queryByRole("radio")).toBeNull();
  });

  it("names the steering repository when it is the one picked", () => {
    const root = wizard([
      { ...MAIN, tree: absentTree("rpb_main01", "main", "acme/platform") },
    ]);
    expect(within(root).getByTestId("init-wizard-role-note")).toHaveTextContent(
      "acme/platform is this workspace’s steering repository.",
    );
  });

  it("prints the link's refusal and writes nothing else (negative)", async () => {
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
    expect(actions.setProductionBranch).not.toHaveBeenCalled();
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("proposes the link as a steering PR and stops before the branch move and the pull request", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        defaultRef: "main",
        status: "proposed",
        steeringPullRequest: {
          number: 43,
          url: "https://github.com/acme/platform/pull/43",
          reused: false,
        },
      },
    });
    const user = userEvent.setup();
    const root = wizard([MAIN, AVAILABLE]);
    await toLastStep(user, root, "release");
    await user.click(within(root).getByTestId("init-wizard-open"));
    const proposal = await within(root).findByTestId("init-wizard-steering-pr");
    expect(proposal).toHaveAttribute("data-state", "proposed");
    expect(proposal).toHaveTextContent(
      "Steering PR #43 adds acme/infra to workspace.toml.",
    );
    expect(proposal).toHaveTextContent(
      "Merge the steering PR to finish linking.",
    );
    expect(
      within(proposal).getByTestId("init-wizard-steering-pr-link"),
    ).toHaveAttribute("href", "https://github.com/acme/platform/pull/43");
    expect(within(root).getByTestId("init-wizard-resume")).toHaveTextContent(
      "Once acme/infra is linked, open this wizard again to add .oxagen/ to it.",
    );
    expect(actions.linkWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "infra" },
    );
    expect(actions.setProductionBranch).not.toHaveBeenCalled();
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    // The footer is gone: there is nothing left to open from here.
    expect(within(root).queryByTestId("init-wizard-open")).toBeNull();
    expect(within(root).queryByTestId("init-wizard-back")).toBeNull();
    // A steering PR is a write, so the page re-reads.
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("says a steering PR already open adds the repository", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        defaultRef: "main",
        status: "proposed",
        steeringPullRequest: {
          number: 43,
          url: "https://github.com/acme/platform/pull/43",
          reused: true,
        },
      },
    });
    const user = userEvent.setup();
    const root = wizard([MAIN, AVAILABLE]);
    await toLastStep(user, root);
    await user.click(within(root).getByTestId("init-wizard-open"));
    const proposal = await within(root).findByTestId("init-wizard-steering-pr");
    expect(proposal).toHaveAttribute("data-state", "reused");
    expect(proposal).toHaveTextContent(
      "Steering PR #43 already adds acme/infra to workspace.toml.",
    );
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
  });

  it("says the next steering sync links a repository workspace.toml lists already", async () => {
    actions.linkWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        fullName: "acme/infra",
        defaultRef: "main",
        status: "listed",
        steeringPullRequest: null,
      },
    });
    const user = userEvent.setup();
    const root = wizard([MAIN, AVAILABLE]);
    await toLastStep(user, root);
    await user.click(within(root).getByTestId("init-wizard-open"));
    const proposal = await within(root).findByTestId("init-wizard-steering-pr");
    expect(proposal).toHaveAttribute("data-state", "listed");
    expect(proposal).toHaveTextContent(
      "workspace.toml lists acme/infra already. The next steering sync links it.",
    );
    expect(
      within(proposal).queryByTestId("init-wizard-steering-pr-link"),
    ).toBeNull();
    expect(actions.setProductionBranch).not.toHaveBeenCalled();
    expect(actions.openInitPullRequest).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it("prints the branch write's refusal and opens no pull request (negative)", async () => {
    actions.setProductionBranch.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "branch_not_found",
    });
    const user = userEvent.setup();
    const root = wizard([MAIN, BOUND_LINKED]);
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
      "GitHub is not connected to this workspace yet.",
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
