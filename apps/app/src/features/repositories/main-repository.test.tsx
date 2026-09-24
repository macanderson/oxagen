// @vitest-environment jsdom
// The Repositories page's GitHub setup over fake reads and a fake bind: each
// of the states the panel can be in is drawn from what the capabilities
// answered, never guessed. It lived in a Workspace settings dialog until the
// workspace menu stopped carrying Settings; every case below is the same case
// it was there.
//
// The assertion that earns this file is the third describe block. Binding a
// main repository was unreachable before this: the only affordance offered the
// one git remote the enrolling host reported, and it refused with
// `github_not_connected` unless an installation was already attached, which
// nothing in the app could produce. Here a person installs the App and then
// picks out of what the installation actually reaches.
import {
  cleanup,
  render,
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
  GitHubInstallations,
  InstallationRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { phoneWidth } from "@/test/phone";

const readWorkspaceRepository = vi.fn();
const listInstallationRepositories = vi.fn();
const bindWorkspaceRepository = vi.fn();
const listGithubInstallations = vi.fn();
const attachGithubInstallation = vi.fn();
const connectGitLabProject = vi.fn();
vi.mock("./actions", () => ({
  connectGitLabProject,
  readWorkspaceRepository,
  listInstallationRepositories,
  bindWorkspaceRepository,
  listGithubInstallations,
  attachGithubInstallation,
}));

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

const { RepositorySetup } = await import("./main-repository");

// Three doors, and the contract now names them apart. `connectUrl` is the
// IDENTITY leg — authorize Oxagen as this GitHub user, for an account that
// already carries the App. `installUrl` is `installations/new` SIGNED with the
// same state, the door that puts the App on an account that does not have it.
// `manageUrl` is that page bare, for reconfiguring an installation already
// attached — it round-trips nothing, which is why it is not the install door
// (#3254). A deployment that can mint one can mint all three.
const CONNECT_URL =
  "https://github.com/login/oauth/authorize?client_id=Iv1.test&state=signed";
const INSTALL_URL =
  "https://github.com/apps/oxagen/installations/new?state=signed";
const MANAGE_URL = "https://github.com/settings/installations/42";

const notConnected: WorkspaceRepository = {
  repository: null,
  github: {
    connected: false,
    connectUrl: CONNECT_URL,
    installUrl: INSTALL_URL,
    manageUrl: MANAGE_URL,
  },
};

const reachable: GitHubInstallations = {
  installations: [
    {
      installationId: "111",
      accountLogin: "acme",
      accountType: "Organization",
      avatarUrl: null,
      repositorySelection: "all",
    },
    {
      installationId: "222",
      accountLogin: "mac",
      accountType: "User",
      avatarUrl: null,
      repositorySelection: "selected",
    },
  ],
};

/** The first-time state: GitHub has never been authorized for this org. */
const NOT_AUTHORIZED = {
  ok: false,
  reason: "conflict",
  code: "github_not_authorized",
} as const;

/**
 * An installation is attached and nothing is bound: the picker's state.
 *
 * All three URLs, because that is the only shape the contract mints — the
 * handler builds them from one env read and answers null for all three or a
 * string for all three (`envGithubUrls`, packages/handlers). A fixture with a
 * manage URL and no doors is a deployment that cannot exist, and it hid the
 * state this file now covers: the doors that recover a stale installation
 * cannot be drawn by a record that carries neither.
 */
const connected: WorkspaceRepository = {
  repository: null,
  github: {
    connected: true,
    connectUrl: CONNECT_URL,
    installUrl: INSTALL_URL,
    manageUrl: MANAGE_URL,
  },
};

const BOUND_REPOSITORY = {
  bindingId: "rpb_0a1b2c",
  provider: "github" as const,
  owner: "acme",
  name: "platform",
  fullName: "acme/platform",
  defaultRef: "main",
  htmlUrl: "https://github.com/acme/platform",
  boundAt: "2026-09-16T10:00:00.000Z",
  connectionLive: true,
};

const bound: WorkspaceRepository = {
  repository: BOUND_REPOSITORY,
  github: {
    connected: true,
    connectUrl: null,
    installUrl: null,
    manageUrl: MANAGE_URL,
  },
};

/**
 * The same repository, bound through a connection that has since been deleted:
 * steering is off and nothing on screen used to say so (#3233). A replacement
 * connection is attached, which is what the reconnect binds through.
 */
const retired: WorkspaceRepository = {
  repository: { ...BOUND_REPOSITORY, connectionLive: false },
  github: {
    connected: true,
    connectUrl: CONNECT_URL,
    installUrl: INSTALL_URL,
    manageUrl: MANAGE_URL,
  },
};

const listing: InstallationRepositories = {
  repositories: [
    {
      id: "8812",
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      defaultBranch: "main",
      private: true,
      htmlUrl: "https://github.com/acme/platform",
    },
    {
      id: "9014",
      owner: "acme",
      name: "docs-site",
      fullName: "acme/docs-site",
      defaultBranch: "trunk",
      private: false,
      htmlUrl: "https://github.com/acme/docs-site",
    },
  ],
  truncated: false,
};

/** The setup section as the Repositories tab renders it. */
function Shell({ container }: { container?: HTMLElement } = {}) {
  return render(
    <IntlProvider>
      <RepositorySetup org="acme" ws="core-platform" />
    </IntlProvider>,
    container ? { container } : undefined,
  );
}

async function openSettings(container?: HTMLElement) {
  const user = userEvent.setup();
  Shell({ container });
  return {
    user,
    dialog: await screen.findByTestId("repository-setup"),
  };
}

// jsdom has no matchMedia, and the sheet and phone helpers read it.
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  nav.pathname = "/acme/core-platform/repositories";
  nav.query = "";
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.refresh.mockReset();
  readWorkspaceRepository.mockReset();
  listInstallationRepositories.mockReset();
  bindWorkspaceRepository.mockReset();
  listGithubInstallations.mockReset();
  attachGithubInstallation.mockReset();
  connectGitLabProject.mockReset();
  // The ordinary first-time default: nobody has authorized GitHub yet, so
  // there is nothing to pick from and the doors are the whole panel.
  listGithubInstallations.mockResolvedValue(NOT_AUTHORIZED);
  attachGithubInstallation.mockResolvedValue({
    ok: true,
    value: { connectionId: "con_abc123", accountLogin: "acme" },
  });
  readWorkspaceRepository.mockResolvedValue({ ok: true, value: notConnected });
  listInstallationRepositories.mockResolvedValue({ ok: true, value: listing });
  bindWorkspaceRepository.mockResolvedValue({
    ok: true,
    value: {
      fullName: "acme/platform",
      defaultRef: "main",
      boundAt: "2026-09-17T09:00:00.000Z",
    },
  });
});
afterEach(cleanup);

describe("no GitHub App installation", () => {
  it("shows a pending state while the record is read, never a blank panel", async () => {
    let answer!: (value: unknown) => void;
    readWorkspaceRepository.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openSettings();
    expect(screen.getByTestId("workspace-repository-loading")).toBeTruthy();
    answer({ ok: true, value: notConnected });
    expect(
      await screen.findByTestId("workspace-repository-install"),
    ).toBeTruthy();
  });

  // The defect this fixes. The panel rendered exactly one link — the identity
  // URL — so a person with the App installed nowhere authorized, came back
  // unchanged, and pressed the same button again. Both doors, or neither.
  it("offers BOTH doors: install the App, and connect an existing installation", async () => {
    await openSettings();
    const install = await screen.findByTestId("workspace-github-install");
    expect(install).toHaveAttribute("href", INSTALL_URL);
    expect(install).toHaveAttribute("rel", "noopener noreferrer");
    const connect = screen.getByTestId("workspace-github-connect");
    expect(connect).toHaveAttribute("href", CONNECT_URL);
    expect(listInstallationRepositories).not.toHaveBeenCalled();
  });

  // A deployment with no App configured has no door to offer. Saying so beats
  // a button that goes nowhere.
  it("says the App is unconfigured instead of rendering a dead button (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: null,
        github: {
          connected: false,
          connectUrl: null,
          installUrl: null,
          manageUrl: null,
        },
      },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-github-unconfigured"),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-install")).toBeNull();
    expect(screen.queryByTestId("workspace-github-connect")).toBeNull();
  });

  it("refuses to link a URL that is not a page on github.com (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: null,
        github: {
          connected: false,
          connectUrl: "https://github.com.evil.example/apps/oxagen",
          installUrl: "https://github.com.evil.example/apps/oxagen",
          manageUrl: "https://github.com.evil.example/apps/oxagen",
        },
      },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-github-unconfigured"),
    ).toBeTruthy();
  });

  /**
   * The install door has to round-trip our state (#3254).
   *
   * It was wired to the MANAGE url, which carries none. So a first-ever
   * install — the primary first-run path for every new customer — landed on the
   * callback with nothing to attribute it to: the no-state branch attached
   * nothing and dropped the person on the app root, workspace still
   * unconnected, with "Connect an existing installation" the only way out and
   * no way to know it.
   */
  it("opens a SIGNED install door, never the bare manage URL", async () => {
    await openSettings();
    const install = await screen.findByTestId("workspace-github-install");
    const href = install.getAttribute("href") ?? "";
    expect(href).toBe(INSTALL_URL);
    expect(new URL(href).searchParams.get("state")).not.toBeNull();
    // The manage URL is the same page without the state, and is not this door.
    expect(href).not.toBe(MANAGE_URL);
  });

  it("draws the door it can and drops the one it cannot (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: null,
        github: {
          connected: false,
          connectUrl: CONNECT_URL,
          installUrl: null,
          manageUrl: null,
        },
      },
    });
    await openSettings();
    expect(await screen.findByTestId("workspace-github-connect")).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-install")).toBeNull();
    expect(screen.queryByTestId("workspace-github-unconfigured")).toBeNull();
  });

  it("has no axe violations with both doors showing", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-install");
    await expectNoAxe(dialog);
  });
});

// The other half of the connect. The Connect action opens GitHub's identity
// URL, which always returns a code and never an `installation_id` — so a person
// whose account already carries the App comes back authorized with nothing
// attached. The API's callback settles that itself when the answer is
// unambiguous; when it is not, this picker is the choice.
describe("choosing which installation the workspace acts through", () => {
  beforeEach(() => {
    listGithubInstallations.mockResolvedValue({ ok: true, value: reachable });
  });

  it("asks what this account reaches, and names each installation", async () => {
    await openSettings();
    const picker = await screen.findByTestId("workspace-installation-picker");
    expect(listGithubInstallations).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    // Cited by the account a person reads, never by the installation id.
    expect(within(picker).getByText("acme")).toBeTruthy();
    expect(within(picker).getByText("mac")).toBeTruthy();
    expect(within(picker).queryByText("111")).toBeNull();
    expect(within(picker).getByText("all repositories")).toBeTruthy();
    expect(within(picker).getByText("selected repositories")).toBeTruthy();
  });

  it("shows a pending state while the live GitHub list is fetched", async () => {
    let answer!: (value: unknown) => void;
    listGithubInstallations.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openSettings();
    expect(
      await screen.findByTestId("workspace-installations-loading"),
    ).toBeTruthy();
    answer({ ok: true, value: reachable });
    expect(
      await screen.findByTestId("workspace-installation-picker"),
    ).toBeTruthy();
  });

  it("attaches the installation a person picked and re-reads the panel", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    await user.click(screen.getByRole("radio", { name: /mac/ }));
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
    await user.click(
      screen.getByRole("button", { name: "Use this installation" }),
    );

    expect(attachGithubInstallation).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "222",
    );
    // Now connected, so the very next thing drawn is the repository picker.
    expect(
      await screen.findByTestId("workspace-repository-picker"),
    ).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalled();
  });

  // The acknowledgement describes the return leg, and the attach it asked for
  // answers it. Leaving "pick which account" above the repository picker reads
  // as an instruction the person has not followed.
  it("drops the acknowledgement once the attach it asked for has happened", async () => {
    nav.query = "settings=repository&github=choose";
    Shell();
    await screen.findByTestId("workspace-installation-picker");
    expect(screen.getByTestId("workspace-github-choose")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /acme/ }));
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
    await user.click(
      screen.getByRole("button", { name: "Use this installation" }),
    );

    expect(
      await screen.findByTestId("workspace-repository-picker"),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-choose")).toBeNull();
  });

  it("asks for a choice rather than attaching one nobody picked (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    await user.click(
      screen.getByRole("button", { name: "Use this installation" }),
    );
    expect(attachGithubInstallation).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("workspace-installation-attach-failure"),
    ).toHaveTextContent("Choose an installation first.");
  });

  it("attaches once however many times the button is pressed", async () => {
    let answer!: (value: unknown) => void;
    attachGithubInstallation.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { user } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    await user.click(screen.getByRole("radio", { name: /acme/ }));
    await user.click(
      screen.getByRole("button", { name: /Use this installation/ }),
    );
    await user.click(screen.getByRole("button", { name: /Attaching/ }));
    expect(attachGithubInstallation).toHaveBeenCalledTimes(1);
    answer({
      ok: true,
      value: { connectionId: "con_abc123", accountLogin: "acme" },
    });
  });

  // The security property the handler holds, said back to the person: an id
  // the connected account cannot reach is refused, and the panel says so
  // rather than pretending the attach landed.
  it("reads back an installation the account cannot reach (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    await user.click(screen.getByRole("radio", { name: /acme/ }));
    attachGithubInstallation.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "installation_unreachable",
    });
    await user.click(
      screen.getByRole("button", { name: "Use this installation" }),
    );
    expect(
      await screen.findByTestId("workspace-installation-attach-failure"),
    ).toHaveTextContent("cannot reach that installation");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("survives an attach that threw without claiming it landed (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    await user.click(screen.getByRole("radio", { name: /acme/ }));
    attachGithubInstallation.mockRejectedValue(new Error("network"));
    await user.click(
      screen.getByRole("button", { name: "Use this installation" }),
    );
    expect(
      await screen.findByTestId("workspace-installation-attach-failure"),
    ).toHaveTextContent("action_failed");
  });

  // `github_not_authorized` is the precondition, not a fault: nobody has
  // connected GitHub for this org yet. The Connect door is the answer, and an
  // alert here would put a red box on the most ordinary state this panel has.
  it("draws no alarm for the ordinary never-connected state (negative)", async () => {
    listGithubInstallations.mockResolvedValue(NOT_AUTHORIZED);
    await openSettings();
    await screen.findByTestId("workspace-repository-install");
    expect(screen.queryByTestId("workspace-installations-failure")).toBeNull();
    expect(screen.queryByTestId("workspace-installation-picker")).toBeNull();
    expect(screen.getByTestId("workspace-github-connect")).toBeTruthy();
  });

  // Every other refusal IS shown: a list that could not be read and a list with
  // nothing in it are different facts, and only one means "install the App".
  it("says what went wrong for any other refusal (negative)", async () => {
    listGithubInstallations.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "github_unreachable",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-installations-failure"),
    ).toHaveTextContent("github_unreachable");
    // The doors are still drawn, so the person still has somewhere to go.
    expect(screen.getByTestId("workspace-github-install")).toBeTruthy();
  });

  it("draws no picker when the account reaches nothing, only the doors (negative)", async () => {
    listGithubInstallations.mockResolvedValue({
      ok: true,
      value: { installations: [] },
    });
    await openSettings();
    await screen.findByTestId("workspace-repository-install");
    expect(screen.queryByTestId("workspace-installation-picker")).toBeNull();
    expect(screen.getByTestId("workspace-github-install")).toHaveAttribute(
      "href",
      INSTALL_URL,
    );
  });

  it("drops a list that arrives after the dialog is gone (negative)", async () => {
    let answer!: (value: unknown) => void;
    listGithubInstallations.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openSettings();
    await screen.findByTestId("workspace-installations-loading");
    cleanup();
    answer({ ok: true, value: reachable });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-installation-picker")).toBeNull();
    });
  });

  it("has no axe violations with the installation picker showing", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    await expectNoAxe(dialog);
  });
});

describe("picking the main repository", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
  });

  it("lists exactly the repositories the installation reaches, with their default branch", async () => {
    await openSettings();
    // Scoped to the picker: the Repositories section below cites the bound
    // main repository by the same name.
    const picker = await screen.findByTestId("workspace-repository-picker");
    expect(listInstallationRepositories).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(within(picker).getByText("acme/platform")).toBeTruthy();
    expect(within(picker).getByText("acme/docs-site")).toBeTruthy();
    expect(within(picker).getByText("default branch trunk")).toBeTruthy();
  });

  it("shows a pending state while the live GitHub list is fetched", async () => {
    let answer!: (value: unknown) => void;
    listInstallationRepositories.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repositories-loading"),
    ).toBeTruthy();
    answer({ ok: true, value: listing });
    expect(
      await screen.findByTestId("workspace-repository-picker"),
    ).toBeTruthy();
  });

  it("binds the repository a person picked and re-reads the panel", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "platform" },
    );
    expect(
      await screen.findByTestId("workspace-repository-bound"),
    ).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("asks for a choice rather than binding a repository nobody picked (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(bindWorkspaceRepository).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("workspace-repository-bind-failure"),
    ).toHaveTextContent("Choose a repository first.");
  });

  it("refuses to bind a pick the filter has hidden, rather than binding what is off screen (negative)", async () => {
    // The bind resolved its choice from the full list while the form rendered
    // a filtered one, so picking a repository and then narrowing the filter
    // past it bound a repository that was not on screen. A bound main repo
    // cannot be changed from this panel, so that mis-bind is permanent.
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));

    await user.type(screen.getByTestId("workspace-repository-filter"), "docs");
    expect(screen.queryByRole("radio", { name: /acme\/platform/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(bindWorkspaceRepository).not.toHaveBeenCalled();
    expect(
      await screen.findByTestId("workspace-repository-bind-failure"),
    ).toHaveTextContent("Choose a repository first.");
  });

  it("keeps the selection when the filter is cleared again", async () => {
    // The fix resolves from what is shown; it deliberately does not clear
    // `picked`, so a filter typed and then undone does not silently discard
    // the choice a person already made.
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));

    const filter = screen.getByTestId("workspace-repository-filter");
    await user.type(filter, "docs");
    await user.clear(filter);

    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "platform" },
    );
  });

  it("filters by name, and says so when nothing matches (negative)", async () => {
    const { user } = await openSettings();
    const picker = await screen.findByTestId("workspace-repository-picker");
    await user.type(screen.getByTestId("workspace-repository-filter"), "docs");
    expect(within(picker).queryByText("acme/platform")).toBeNull();
    expect(within(picker).getByText("acme/docs-site")).toBeTruthy();

    await user.clear(screen.getByTestId("workspace-repository-filter"));
    await user.type(screen.getByTestId("workspace-repository-filter"), "zzz");
    expect(
      screen.getByTestId("workspace-repositories-no-match"),
    ).toHaveTextContent("No repository matches “zzz”.");
  });

  // Honest rather than paginated: the person is told the set is short, and
  // where to widen it, instead of hunting for a repository that was dropped.
  it("says the list is short and offers the way to widen it", async () => {
    listInstallationRepositories.mockResolvedValue({
      ok: true,
      value: { ...listing, truncated: true },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repositories-truncated"),
    ).toBeTruthy();
    expect(screen.getByTestId("workspace-github-manage")).toHaveAttribute(
      "href",
      MANAGE_URL,
    );
  });

  it("teaches the empty installation instead of showing a bind with nothing to bind", async () => {
    listInstallationRepositories.mockResolvedValue({
      ok: true,
      value: { repositories: [], truncated: false },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repositories-empty"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Bind as main repo" }),
    ).toBeNull();
  });

  it("reads a refused list rather than showing an empty one (negative)", async () => {
    listInstallationRepositories.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repositories-failure"),
    ).toHaveTextContent("No GitHub App installation is attached");
  });

  it("reads back a bind the installation cannot serve (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));
    bindWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "repository_not_installed",
    });
    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(
      await screen.findByTestId("workspace-repository-bind-failure"),
    ).toHaveTextContent("The installation cannot read that repository.");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("says a workspace that already binds another repository cannot be moved here (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));
    bindWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "main_repo_bound",
    });
    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(
      await screen.findByTestId("workspace-repository-bind-failure"),
    ).toHaveTextContent("already binds a different main repository");
  });

  it("survives a bind that threw without claiming the repository is bound (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));
    bindWorkspaceRepository.mockRejectedValue(new Error("network"));
    await user.click(screen.getByRole("button", { name: "Bind as main repo" }));

    expect(
      await screen.findByTestId("workspace-repository-bind-failure"),
    ).toHaveTextContent("action_failed");
    expect(screen.queryByTestId("workspace-repository-bound")).toBeNull();
  });

  it("survives a list that threw without showing an empty picker (negative)", async () => {
    listInstallationRepositories.mockRejectedValue(new Error("network"));
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repositories-failure"),
    ).toHaveTextContent("action_failed");
  });

  it("binds once however many times the button is pressed", async () => {
    let answer!: (value: unknown) => void;
    bindWorkspaceRepository.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.click(screen.getByRole("radio", { name: /acme\/platform/ }));
    const submit = screen.getByRole("button", { name: /Bind as main repo/ });
    await user.click(submit);
    await user.click(screen.getByRole("button", { name: /Binding/ }));

    expect(bindWorkspaceRepository).toHaveBeenCalledTimes(1);
    answer({
      ok: true,
      value: {
        fullName: "acme/platform",
        defaultRef: "main",
        boundAt: "2026-09-17T09:00:00.000Z",
      },
    });
  });

  // The person closed the dialog, or left the page, before GitHub answered.
  it("drops a list that arrives after the dialog is gone (negative)", async () => {
    let answer!: (value: unknown) => void;
    listInstallationRepositories.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openSettings();
    await screen.findByTestId("workspace-repositories-loading");
    cleanup();
    answer({ ok: true, value: listing });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-repository-picker")).toBeNull();
    });
  });

  it("has no axe violations with the picker showing", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await expectNoAxe(dialog);
  });
});

/**
 * An installation is on file and GitHub will not serve it (#3233).
 *
 * `get_main_repository` makes no GitHub API call, deliberately — it is a
 * settings read that has to render while GitHub is down — so it reports
 * `github.connected` from the stored installation id whether or not that
 * installation still exists. Uninstalling the App, suspending it, or revoking
 * its access leaves the id behind, and the first thing that notices is
 * `list_installation_repositories`, at the token it mints.
 *
 * The panel used to draw that refusal and nothing else: no picker, no doors,
 * no manage link, on the one surface that owns replacing an installation and
 * reinstalling the App. The workspace could not leave the state from here.
 * These assert the way out is on screen with the reason, and that none of it
 * leaks into a healthy listing.
 */
describe("an installation the listing could not use", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
    // What a revoked installation does: the handler's token mint throws, and
    // the action answers `unavailable: action_failed`.
    listInstallationRepositories.mockRejectedValue(
      new Error("Bad credentials"),
    );
    listGithubInstallations.mockResolvedValue({ ok: true, value: reachable });
  });

  it("keeps the refusal AND draws both doors out of it", async () => {
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repositories-failure"),
    ).toHaveTextContent("action_failed");

    const doors = await screen.findByTestId("workspace-repository-install");
    // Not "nothing is attached yet": one IS, and it could not be used.
    expect(doors).toHaveTextContent("would not let Oxagen use it");
    expect(screen.getByTestId("workspace-github-install")).toHaveAttribute(
      "href",
      INSTALL_URL,
    );
    expect(screen.getByTestId("workspace-github-connect")).toHaveAttribute(
      "href",
      CONNECT_URL,
    );
  });

  // The fastest repair, and the only one that never leaves the app: the
  // callback and `attach_github_installation` both OVERWRITE
  // `deliveryConfig.installationId` on the connection already there, so
  // choosing a live installation replaces the stale id outright.
  it("offers the installations this account still reaches, and attaches one", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-installation-picker");
    expect(listGithubInstallations).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );

    await user.click(screen.getByRole("radio", { name: /mac/ }));
    // The repair worked: the next read lists repositories again.
    listInstallationRepositories.mockResolvedValue({
      ok: true,
      value: listing,
    });
    await user.click(
      screen.getByRole("button", { name: "Use this installation" }),
    );

    expect(attachGithubInstallation).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "222",
    );
    const picker = await screen.findByTestId("workspace-repository-picker");
    expect(within(picker).getByText("acme/platform")).toBeTruthy();
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
  });

  // The other cause: the installation is live but reaches nothing this token
  // may read, or is suspended. That is settled on the App's own page, and the
  // ready picker offers exactly this link — skipping it here took a control
  // away from the person who needs it most.
  it("still offers the App's settings beside the refusal", async () => {
    await openSettings();
    const refused = await screen.findByTestId("workspace-repositories-refused");
    expect(
      within(refused).getByTestId("workspace-github-manage"),
    ).toHaveAttribute("href", MANAGE_URL);
  });

  it("says the App is unconfigured rather than drawing dead doors (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: null,
        github: {
          connected: true,
          connectUrl: null,
          installUrl: null,
          manageUrl: null,
        },
      },
    });
    await openSettings();
    await screen.findByTestId("workspace-repositories-failure");
    expect(
      await screen.findByTestId("workspace-github-unconfigured"),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-install")).toBeNull();
    expect(screen.queryByTestId("workspace-github-connect")).toBeNull();
    expect(screen.queryByTestId("workspace-github-manage")).toBeNull();
  });

  it("has no axe violations with the way out showing", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-install");
    await expectNoAxe(dialog);
  });
});

// The healthy listing, asserted from the other side: none of the recovery
// above may appear where nothing is wrong, and the extra GitHub call that
// finds the replacement installation must not fire on the ordinary path.
describe("a listing that worked", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
  });

  it("draws no recovery doors and no refusal (negative)", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    expect(screen.queryByTestId("workspace-repositories-refused")).toBeNull();
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    expect(screen.queryByTestId("workspace-github-install")).toBeNull();
    expect(screen.queryByTestId("workspace-github-connect")).toBeNull();
    // The manage link is the picker's own, not the refusal's.
    expect(screen.getByTestId("workspace-github-manage")).toBeTruthy();
  });

  it("asks GitHub for no installations it does not need (negative)", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    expect(listGithubInstallations).not.toHaveBeenCalled();
  });
});

describe("a bound main repository", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
  });

  it("cites the repository, the branch .oxagen/ is read from, and when it was bound", async () => {
    await openSettings();
    const panel = await screen.findByTestId("workspace-repository-bound");
    expect(panel).toHaveTextContent("acme/platform");
    expect(panel).toHaveTextContent("main");
    expect(screen.getByTestId("workspace-repository-bound-at")).toHaveAttribute(
      "datetime",
      "2026-09-16T10:00:00.000Z",
    );
    expect(screen.getByTestId("workspace-repository-open")).toHaveAttribute(
      "href",
      "https://github.com/acme/platform",
    );
  });

  // Spec §10.1: changing which repository is main is an org owner's decision,
  // recorded as a security event, and `bind_main_repository` refuses with
  // `main_repo_bound`. A rebind control here would be a control that lies.
  it("offers no rebind, and says why, while still offering the App's settings", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    expect(screen.queryByTestId("workspace-repository-picker")).toBeNull();
    expect(listInstallationRepositories).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be changed here/i)).toBeTruthy();
    expect(screen.getByTestId("workspace-github-manage")).toHaveAttribute(
      "href",
      MANAGE_URL,
    );
  });

  it("offers no App settings link when the App is unconfigured (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: bound.repository,
        github: {
          connected: true,
          connectUrl: null,
          installUrl: null,
          manageUrl: null,
        },
      },
    });
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    expect(screen.queryByTestId("workspace-github-manage")).toBeNull();
  });

  it("drops a record that arrives after the dialog is gone (negative)", async () => {
    let answer!: (value: unknown) => void;
    readWorkspaceRepository.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openSettings();
    await screen.findByTestId("workspace-repository-loading");
    cleanup();
    answer({ ok: true, value: bound });
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-repository-bound")).toBeNull();
    });
  });

  it("has no axe violations with a repository bound", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    await expectNoAxe(dialog);
  });

  // ARCHITECTURE.md §1.2, the phone shell: every control in the section is a
  // 44px touch target at phone width, so none of it needs a stylus.
  it("keeps every control a 44px touch target on a phone", async () => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
    const phone = phoneWidth();
    try {
      await openSettings(phone.container);
      await screen.findByTestId("workspace-repository-bound");
      const targets = phone.container.querySelectorAll("[data-touch-target]");
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets)
        expect(getComputedStyle(target).minHeight).toBe("44px");
    } finally {
      phone.restore();
    }
  });
});

/**
 * The connection behind the binding was retired (#3233).
 *
 * Delete the workspace's GitHub connection and reconnect and the head still
 * names the deleted one, so `readGitHubConnection` resolves nothing and
 * steering and Context PRs are off — while the panel went on drawing a bound
 * repository and a note saying this is not the place to change it. The
 * workspace looked fine, and no surface could fix it.
 */
describe("a binding whose connection was retired", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: retired });
  });

  it("says steering is off and still cites the repository that is bound", async () => {
    await openSettings();
    const panel = await screen.findByTestId("workspace-repository-bound");
    expect(panel).toHaveTextContent("acme/platform");
    expect(
      await screen.findByTestId("workspace-repository-retired"),
    ).toHaveTextContent(/steering and Context PRs are off/i);
    // Not the "this cannot be changed here" note: that answers a different
    // question, and here there IS something the person can do.
    expect(screen.queryByText(/cannot be changed here/i)).toBeNull();
  });

  it("re-binds the SAME repository, by the owner and name already bound", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });

    await user.click(
      screen.getByRole("button", { name: "Reconnect this repository" }),
    );

    // The repair, not a choice of repository: no picker was ever drawn, and
    // the bind names what the binding already carried.
    expect(bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "platform" },
    );
    expect(screen.queryByTestId("workspace-repository-picker")).toBeNull();
    expect(listInstallationRepositories).not.toHaveBeenCalled();
  });

  it("re-reads the panel after the repair, and the rest of the app with it", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });

    await user.click(
      screen.getByRole("button", { name: "Reconnect this repository" }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("workspace-repository-retired")).toBeNull();
    });
    expect(screen.getByText(/cannot be changed here/i)).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("says why a refused repair was refused, and leaves the panel as it was (negative)", async () => {
    bindWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "github_not_connected",
    });
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-retired");

    await user.click(
      screen.getByRole("button", { name: "Reconnect this repository" }),
    );

    expect(
      await screen.findByTestId("workspace-repository-reconnect-failure"),
    ).toBeTruthy();
    expect(screen.getByTestId("workspace-repository-retired")).toBeTruthy();
  });

  it("offers the doors instead of a repair when no live connection is attached (negative)", async () => {
    // Deleted and not reconnected: the bind would refuse
    // `github_not_connected`, so a Reconnect button here could only fail.
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: retired.repository,
        github: {
          connected: false,
          connectUrl: CONNECT_URL,
          installUrl: INSTALL_URL,
          manageUrl: MANAGE_URL,
        },
      },
    });
    await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    expect(
      screen.queryByRole("button", { name: "Reconnect this repository" }),
    ).toBeNull();
    // Still cites the repository it binds, and offers the way back.
    expect(screen.getByTestId("workspace-repository-bound")).toHaveTextContent(
      "acme/platform",
    );
    expect(
      await screen.findByTestId("workspace-repository-install"),
    ).toBeTruthy();
  });

  it("offers no rebind affordance at all while the connection is live (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    expect(screen.queryByTestId("workspace-repository-retired")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reconnect this repository" }),
    ).toBeNull();
  });

  it("has no axe violations while steering is off", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    await expectNoAxe(dialog);
  });
});

/**
 * Re-approving the production ref on a LIVE connection (#3265 review, P1).
 *
 * Steering pins Context PRs to the binding's approved ref and refuses any other
 * base, so a default-branch rename on GitHub stops the workspace dead. The
 * handler fix makes `bind_main_repository` write a successor when the recorded
 * facts have moved; these prove a person can actually reach it, which is the
 * half that makes it a recovery path rather than an API capability nobody can
 * call.
 */
describe("re-approving the default branch on a live connection", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
  });

  it("offers the re-approval beside the note that the repository itself is fixed", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    const panel = await screen.findByTestId("workspace-repository-reapprove");
    expect(panel).toHaveTextContent(
      /refused until the new branch is approved/i,
    );
    // Both statements are true at once and answer different questions: which
    // repository is main is fixed here; which branch it publishes to is not.
    expect(screen.getByText(/cannot be changed here/i)).toBeTruthy();
  });

  it("binds the SAME owner and name, so nothing about which repository is main moves", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-reapprove");

    await user.click(
      screen.getByRole("button", { name: "Re-approve the default branch" }),
    );

    expect(bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { owner: "acme", name: "platform" },
    );
    // No picker is drawn and no listing is fetched: choosing a repository is a
    // different act, and this one never offers it.
    expect(screen.queryByTestId("workspace-repository-picker")).toBeNull();
    expect(listInstallationRepositories).not.toHaveBeenCalled();
  });

  it("shows the refusal on the panel when the re-approval is refused (negative)", async () => {
    bindWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-reapprove");

    await user.click(
      screen.getByRole("button", { name: "Re-approve the default branch" }),
    );

    expect(
      await screen.findByTestId("workspace-repository-reapprove-failure"),
    ).toHaveTextContent("Only an organization Owner or Admin");
  });

  it("is not drawn twice when the connection is retired — that panel owns the repair", async () => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: retired });
    await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    expect(screen.queryByTestId("workspace-repository-reapprove")).toBeNull();
  });
});

describe("refusals on the panel's own read", () => {
  it("says a member without the role cannot read this, rather than showing nothing (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("Only an organization Owner or Admin");
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
  });

  it("names what is down when GitHub cannot be reached (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "github_unreachable",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("github_unreachable");
  });

  it("carries a pending approval with the request to wait on (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_0101",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("acr_0101");
  });

  it("prints a refusal it has no sentence for as recorded (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "some_new_reason",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("some_new_reason");
  });

  it("says an invalid repository name is not one GitHub accepts (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("not one GitHub accepts");
  });

  // No read here is a governed action (both contracts are noBillingGate), so
  // this cannot happen — but the seam can produce it, and a refusal with no
  // sentence is worse than one nobody expects.
  it("prints an exhausted refusal rather than falling through (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "exhausted",
      code: "gau_exhausted",
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("gau_exhausted");
  });

  it("survives a read that threw (negative)", async () => {
    readWorkspaceRepository.mockRejectedValue(new Error("network"));
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-failure"),
    ).toHaveTextContent("action_failed");
  });

  it("has no axe violations while refused", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-failure");
    await expectNoAxe(dialog);
  });
});

describe("the return leg from GitHub", () => {
  it("acknowledges the install on ?settings=repository and drops the query", async () => {
    nav.query = "settings=repository&github=connected";
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
    Shell();

    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.getByTestId("workspace-github-connected")).toBeTruthy();
    expect(nav.replace).toHaveBeenCalledWith(
      "/acme/core-platform/repositories",
    );
  });

  it("acknowledges nothing and leaves the URL alone on an ordinary visit (negative)", async () => {
    Shell();
    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("says nothing when the query names no install (negative)", async () => {
    nav.query = "settings=repository";
    Shell();
    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
    expect(screen.queryByTestId("workspace-github-failed")).toBeNull();
  });

  // `github=failed` is the API's third outcome: an installation was claimed and
  // declined, because the person who authorized could not be shown to reach it.
  // The panel draws the install door again either way, so without a sentence
  // here they would be looking at the button they just pressed with nothing
  // saying why they are back at it.
  it("says so when the install was declined, and never claims it connected", async () => {
    nav.query = "settings=repository&github=failed";
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: notConnected,
    });
    Shell();

    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.getByTestId("workspace-github-failed")).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
    // The install door is still the thing to press, so it is still drawn.
    expect(
      await screen.findByTestId("workspace-repository-install"),
    ).toBeTruthy();
    expect(nav.replace).toHaveBeenCalledWith(
      "/acme/core-platform/repositories",
    );
  });

  /**
   * `github=authorize` — the install came back with nothing to verify it
   * against (#3254).
   *
   * Whether GitHub returns a `code` alongside the installation id is the App's
   * "request user authorization (OAuth) during installation" setting, external
   * configuration this product cannot flip. Without a code there is no user
   * token, so `GET /user/installations` cannot be asked and the claim is
   * unverifiable — nothing is attached, because an unverifiable claim is the
   * exact shape a forged one takes. What differs from `failed` is the next
   * click: the App IS on the account now, so the identity leg finishes it.
   */
  it("says an installed App is not yet attached, and points at the connect door", async () => {
    nav.query = "settings=repository&github=authorize";
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: notConnected,
    });
    Shell();

    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    const said = screen.getByTestId("workspace-github-authorize");
    expect(said).toHaveTextContent(/nothing has been attached yet/i);
    // Never the word for a real attach.
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
    expect(screen.queryByTestId("workspace-github-failed")).toBeNull();
    // The click it names is on screen.
    expect(
      (await screen.findByTestId("workspace-github-connect")).getAttribute(
        "href",
      ),
    ).toBe(CONNECT_URL);
  });

  // The identity leg's own two answers. The callback lists what the authorizing
  // user reaches and, when it will not guess, says which question is open.
  it("says the account reaches several installations, and shows the picker", async () => {
    nav.query = "settings=repository&github=choose";
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: notConnected,
    });
    listGithubInstallations.mockResolvedValue({ ok: true, value: reachable });
    Shell();

    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.getByTestId("workspace-github-choose")).toBeTruthy();
    expect(
      await screen.findByTestId("workspace-installation-picker"),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
  });

  it("says the App is installed nowhere, and points at the install door", async () => {
    nav.query = "settings=repository&github=install";
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: notConnected,
    });
    listGithubInstallations.mockResolvedValue({
      ok: true,
      value: { installations: [] },
    });
    Shell();

    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.getByTestId("workspace-github-none")).toBeTruthy();
    // Authorizing again would loop: the door that matters is installations/new.
    expect(
      (await screen.findByTestId("workspace-github-install")).getAttribute(
        "href",
      ),
    ).toBe(INSTALL_URL);
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
  });

  // Anything the dialog does not recognise degrades to no acknowledgement. The
  // one outcome worse than silence is announcing a connection that never happened.
  it("acknowledges nothing for an unknown github value (negative)", async () => {
    nav.query = "settings=repository&github=something-else";
    Shell();
    expect(await screen.findByTestId("repository-setup")).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
    expect(screen.queryByTestId("workspace-github-failed")).toBeNull();
    expect(screen.queryByTestId("workspace-github-choose")).toBeNull();
    expect(screen.queryByTestId("workspace-github-none")).toBeNull();
  });
});

/**
 * A gitlab.com main project (#3762). The panel offers the GitLab form beside
 * the GitHub doors whenever nothing is bound, binds through it, and repairs a
 * GitLab binding with a new token rather than with the GitHub App.
 */
describe("connecting a GitLab project", () => {
  const TOKEN = "glpat-abcdefghijklmnopqrstuvwxyz";
  const GITLAB_REPOSITORY = {
    bindingId: "rpb_0a1b2d",
    provider: "gitlab" as const,
    owner: "acme/platform",
    name: "rules",
    fullName: "acme/platform/rules",
    defaultRef: "main",
    htmlUrl: "https://gitlab.com/acme/platform/rules",
    boundAt: "2026-09-23T10:00:00.000Z",
    connectionLive: true,
  };
  const gitlabBound: WorkspaceRepository = {
    repository: GITLAB_REPOSITORY,
    github: {
      connected: false,
      connectUrl: CONNECT_URL,
      installUrl: INSTALL_URL,
      manageUrl: MANAGE_URL,
    },
  };
  const CONNECTED = {
    ok: true,
    value: {
      fullName: "acme/platform/rules",
      defaultRef: "main",
      boundAt: "2026-09-23T10:00:00.000Z",
      webhook: "registered",
    },
  };

  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(
      screen.getByLabelText("Project path"),
      " acme/platform/rules ",
    );
    await user.type(screen.getByLabelText("Project access token"), TOKEN);
  }

  it("offers the GitLab form beside the GitHub doors when nothing is bound", async () => {
    await openSettings();
    expect(await screen.findByTestId("workspace-gitlab-connect")).toBeTruthy();
    expect(screen.getByTestId("workspace-repository-install")).toBeTruthy();
    expect(
      screen.getByLabelText("Project access token").getAttribute("type"),
    ).toBe("password");
  });

  it("connects and binds the project, clears the token, and re-reads the panel", async () => {
    connectGitLabProject.mockResolvedValue(CONNECTED);
    const { user } = await openSettings();
    await screen.findByTestId("workspace-gitlab-connect");
    await fill(user);
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: gitlabBound });
    await user.click(screen.getByRole("button", { name: "Connect and bind" }));

    expect(connectGitLabProject).toHaveBeenCalledWith("acme", "core-platform", {
      projectPath: "acme/platform/rules",
      token: TOKEN,
    });
    const boundPanel = await screen.findByTestId("workspace-repository-bound");
    expect(within(boundPanel).getByText("acme/platform/rules")).toBeTruthy();
    expect(
      within(boundPanel)
        .getByRole("link", { name: "Open on GitLab" })
        .getAttribute("href"),
    ).toBe("https://gitlab.com/acme/platform/rules");
    // No GitHub installation to manage, and no GitHub doors for a GitLab binding.
    expect(screen.queryByTestId("workspace-github-manage")).toBeNull();
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("says what GitLab refused and keeps no token on the page (negative)", async () => {
    connectGitLabProject.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "gitlab_credential_rejected",
    });
    const { user } = await openSettings();
    await screen.findByTestId("workspace-gitlab-connect");
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Connect and bind" }));

    expect(
      (await screen.findByTestId("workspace-gitlab-failure")).textContent,
    ).toContain("GitLab no longer accepts");
    expect(screen.getByLabelText("Project access token")).toHaveProperty(
      "value",
      "",
    );
  });

  it("tells the person when the webhook could not be registered", async () => {
    connectGitLabProject.mockResolvedValue({
      ...CONNECTED,
      value: { ...CONNECTED.value, webhook: "refused" },
    });
    const { user } = await openSettings();
    await screen.findByTestId("workspace-gitlab-connect");
    await fill(user);
    await user.click(screen.getByRole("button", { name: "Connect and bind" }));
    expect(
      (await screen.findByTestId("workspace-gitlab-notice")).textContent,
    ).toContain("Maintainer");
  });

  it("re-approves a GitLab binding by its project path, not by a GitHub owner and name", async () => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: gitlabBound });
    const { user } = await openSettings();
    const reapprove = await screen.findByTestId(
      "workspace-repository-reapprove",
    );
    await user.click(within(reapprove).getByRole("button"));
    expect(bindWorkspaceRepository).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      { provider: "gitlab", projectPath: "acme/platform/rules" },
    );
  });

  it("repairs a GitLab binding whose token was revoked with a new token for the same project", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        ...gitlabBound,
        repository: { ...GITLAB_REPOSITORY, connectionLive: false },
      },
    });
    connectGitLabProject.mockResolvedValue(CONNECTED);
    const { user } = await openSettings();
    const retired = await screen.findByTestId("workspace-repository-retired");
    const path = within(retired).getByLabelText("Project path");
    expect(path).toHaveProperty("value", "acme/platform/rules");
    expect(path).toHaveProperty("readOnly", true);
    // The GitHub App is not the repair for a GitLab binding.
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    await user.type(
      within(retired).getByLabelText("Project access token"),
      TOKEN,
    );
    await user.click(
      within(retired).getByRole("button", { name: "Connect and bind" }),
    );
    expect(connectGitLabProject).toHaveBeenCalledWith("acme", "core-platform", {
      projectPath: "acme/platform/rules",
      token: TOKEN,
    });
  });

  it("has no axe violations with the GitLab form showing", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-gitlab-connect");
    await expectNoAxe(dialog);
  });
});
