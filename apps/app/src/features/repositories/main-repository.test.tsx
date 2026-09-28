// @vitest-environment jsdom
// The Repositories page's GitHub setup over fake reads: each state the panel
// can be in is drawn from what the capabilities answered.
//
// Oxagen creates the steering repository when it provisions the workspace
// (ADR-212), so the panel binds nothing. It shows a bound head, says steering
// is off when that head's connection was retired, and says Oxagen creates the
// repository while none is bound. The GitHub doors and the installation picker
// are the only controls left: #4616 removed the bind, its repairs, and the
// GitLab connect form.
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
  WorkspaceRepository,
} from "@/data/contracts/repository";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { phoneWidth } from "@/test/phone";

const readWorkspaceRepository = vi.fn();
const listGithubInstallations = vi.fn();
const attachGithubInstallation = vi.fn();
vi.mock("./actions", () => ({
  readWorkspaceRepository,
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
 * An installation is attached and no steering repository is bound yet: the
 * panel says Oxagen creates one, and keeps the doors.
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
 * steering is off, and the panel says so (#3233). A replacement connection is
 * attached, so the panel draws no doors. It offers no repair either, because
 * #4616 removed the bind that did one and #4637 tracks its successor.
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

/** A gitlab.com steering project (#3762). The panel draws no GitHub doors for it. */
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

const RETIRED_SENTENCE =
  "This steering repository's connection was retired, so steering is off.";

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
  listGithubInstallations.mockReset();
  attachGithubInstallation.mockReset();
  // The ordinary first-time default: nobody has authorized GitHub yet, so
  // there is nothing to pick from and the doors are the whole panel.
  listGithubInstallations.mockResolvedValue(NOT_AUTHORIZED);
  attachGithubInstallation.mockResolvedValue({
    ok: true,
    value: { connectionId: "con_abc123", accountLogin: "acme" },
  });
  readWorkspaceRepository.mockResolvedValue({ ok: true, value: notConnected });
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

  // ARCHITECTURE.md §1.2, the phone shell: every control in the section is a
  // 44px touch target at phone width, so none of it needs a stylus.
  it("keeps every control a 44px touch target on a phone", async () => {
    const phone = phoneWidth();
    try {
      await openSettings(phone.container);
      await screen.findByTestId("workspace-github-install");
      const targets = phone.container.querySelectorAll("[data-touch-target]");
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets)
        expect(getComputedStyle(target).minHeight).toBe("44px");
    } finally {
      phone.restore();
    }
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
    // Now connected with no steering repository, so the panel says Oxagen
    // creates one when it provisions the workspace.
    expect(
      await screen.findByTestId("workspace-repository-provisioned"),
    ).toBeTruthy();
    expect(nav.refresh).toHaveBeenCalled();
  });

  // The acknowledgement describes the return leg, and the attach it asked for
  // answers it. Leaving "pick which account" on screen after the account was
  // picked reads as an instruction the person has not followed.
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
      await screen.findByTestId("workspace-repository-provisioned"),
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

/**
 * An installation is attached and no steering repository is bound. Oxagen
 * creates the steering repository when it provisions the workspace (ADR-212),
 * so the panel says that and offers nothing that binds one. The doors stay, so
 * a stale installation can still be replaced.
 */
describe("an installation with no steering repository", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
  });

  it("says Oxagen creates the steering repository, and keeps the doors", async () => {
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-provisioned"),
    ).toHaveTextContent(
      "This workspace has no steering repository yet, and Oxagen creates one when it provisions the workspace.",
    );
    expect(screen.getByTestId("workspace-repository-install")).toHaveTextContent(
      "An installation is attached to this workspace.",
    );
    expect(screen.getByTestId("workspace-github-install")).toHaveAttribute(
      "href",
      INSTALL_URL,
    );
    expect(screen.getByTestId("workspace-github-connect")).toHaveAttribute(
      "href",
      CONNECT_URL,
    );
  });

  it("offers no control that binds a repository (negative)", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-provisioned");
    await waitFor(() => {
      expect(
        screen.queryByTestId("workspace-installations-loading"),
      ).toBeNull();
    });
    // The doors are links. With no installation list to pick from, nothing on
    // the panel is a button, a field, or a list of repositories.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("workspace-repository-bound")).toBeNull();
    expect(screen.queryByTestId("workspace-repository-retired")).toBeNull();
  });

  // `get_main_repository` reports `connected` from the stored installation id
  // without asking GitHub, so the panel still reads what this account reaches.
  it("still lists the installations this account reaches, so a stale one can be replaced", async () => {
    listGithubInstallations.mockResolvedValue({ ok: true, value: reachable });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-installation-picker"),
    ).toBeTruthy();
    expect(listGithubInstallations).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
  });

  it("has no axe violations with no steering repository yet", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-provisioned");
    await expectNoAxe(dialog);
  });
});

describe("a bound steering repository", () => {
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

  // Oxagen writes the steering repository when it provisions the workspace
  // (ADR-212), so a live head is shown and nothing more. The App's settings
  // link is the one way on from here.
  it("shows the head only, with no control that binds or re-binds it", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("workspace-repository-retired")).toBeNull();
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    expect(listGithubInstallations).not.toHaveBeenCalled();
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

  // Oxagen reads a provisioned head through the Oxagen Steering app, so the
  // head is live while the workspace has no GitHub installation of its own.
  // Linking a code repository still needs one (ADR-212), so the doors stay
  // beside the bound panel until an installation is attached.
  it("keeps the doors beside a live head when no installation is attached", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: bound.repository,
        github: {
          connected: false,
          connectUrl: CONNECT_URL,
          installUrl: INSTALL_URL,
          manageUrl: MANAGE_URL,
        },
      },
    });
    await openSettings();
    expect(screen.getByTestId("workspace-repository-bound")).toHaveTextContent(
      "acme/platform",
    );
    expect(
      await screen.findByTestId("workspace-repository-install"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByTestId("workspace-installations-loading"),
      ).toBeNull();
    });
    expect(listGithubInstallations).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(screen.queryByTestId("workspace-repository-retired")).toBeNull();
  });

  // A gitlab.com head (#3762) opens on GitLab and has no GitHub installation
  // to manage, so the panel draws no GitHub settings link for it. The
  // workspace has no GitHub installation either, and linking a code
  // repository needs one, so the doors still show.
  it("opens a GitLab head on GitLab, with no GitHub settings link", async () => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: gitlabBound });
    await openSettings();
    const panel = await screen.findByTestId("workspace-repository-bound");
    expect(within(panel).getByText("acme/platform/rules")).toBeTruthy();
    expect(
      within(panel).getByRole("link", { name: "Open on GitLab" }),
    ).toHaveAttribute("href", "https://gitlab.com/acme/platform/rules");
    expect(screen.queryByTestId("workspace-github-manage")).toBeNull();
    expect(
      await screen.findByTestId("workspace-repository-install"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByTestId("workspace-installations-loading"),
      ).toBeNull();
    });
    expect(listGithubInstallations).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
  });

  it("draws no doors beside a GitLab head once an installation is attached (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        ...gitlabBound,
        github: { ...gitlabBound.github, connected: true },
      },
    });
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(listGithubInstallations).not.toHaveBeenCalled();
  });
});

/**
 * The connection behind the binding was retired (#3233).
 *
 * Delete the workspace's GitHub connection and reconnect, and the head still
 * names the deleted one, so `readGitHubConnection` resolves nothing and
 * steering is off. The panel says so beside the repository it still binds. It
 * offers no repair: #4616 removed the bind that did one, and #4637 tracks its
 * successor.
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
    ).toHaveTextContent(RETIRED_SENTENCE);
  });

  it("renders no button, because no repair is on offer (negative)", async () => {
    await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    // A replacement connection is attached, so there are no doors either, and
    // no App settings link for a connection steering no longer uses.
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    expect(screen.queryByTestId("workspace-github-manage")).toBeNull();
    expect(listGithubInstallations).not.toHaveBeenCalled();
  });

  it("offers the doors, and still no button, when no live connection is attached", async () => {
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
    expect(
      await screen.findByTestId("workspace-repository-retired"),
    ).toHaveTextContent(RETIRED_SENTENCE);
    // Still cites the repository it binds, and offers the way back.
    expect(screen.getByTestId("workspace-repository-bound")).toHaveTextContent(
      "acme/platform",
    );
    expect(
      await screen.findByTestId("workspace-repository-install"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.queryByTestId("workspace-installations-loading"),
      ).toBeNull();
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  // The GitHub App is not the way back for a GitLab head. With a GitHub
  // installation already attached, it gets the sentence and nothing else.
  it("says steering is off for a GitLab head, and draws no GitHub doors for it (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: { ...GITLAB_REPOSITORY, connectionLive: false },
        github: { ...gitlabBound.github, connected: true },
      },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-retired"),
    ).toHaveTextContent(RETIRED_SENTENCE);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("workspace-repository-install")).toBeNull();
    expect(listGithubInstallations).not.toHaveBeenCalled();
  });

  it("draws no retired state while the connection is live (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: bound });
    await openSettings();
    await screen.findByTestId("workspace-repository-bound");
    expect(screen.queryByTestId("workspace-repository-retired")).toBeNull();
  });

  it("has no axe violations while steering is off", async () => {
    const { dialog } = await openSettings();
    await screen.findByTestId("workspace-repository-retired");
    await expectNoAxe(dialog);
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
