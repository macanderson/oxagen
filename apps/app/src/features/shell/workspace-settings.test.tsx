// @vitest-environment jsdom
// The Workspace settings dialog over fake reads and a fake bind: the control
// beside the workspace tile opens it, and each of the states the panel can be
// in is drawn from what the capabilities answered, never guessed.
//
// The assertion that earns this file is the third describe block. Binding a
// main repository was unreachable before this: the only affordance offered the
// one git remote the enrolling host reported, and it refused with
// `github_not_connected` unless an installation was already attached, which
// nothing in the app could produce. Here a person installs the App and then
// picks out of what the installation actually reaches.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  InstallationRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { phoneWidth } from "@/test/phone";
import { shellData } from "./shell.builders";
import { ShellStateProvider } from "./shell-state";
import { SidebarHeader } from "./sidebar";

const readWorkspaceRepository = vi.fn();
const listInstallationRepositories = vi.fn();
const bindWorkspaceRepository = vi.fn();
vi.mock("./workspace-settings-actions", () => ({
  readWorkspaceRepository,
  listInstallationRepositories,
  bindWorkspaceRepository,
}));

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
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

const { WorkspaceSettingsDialog } = await import("./workspace-settings");

const INSTALL_URL =
  "https://github.com/apps/oxagen/installations/new?state=signed";
const MANAGE_URL = "https://github.com/settings/installations/42";

const notConnected: WorkspaceRepository = {
  repository: null,
  github: { connected: false, installUrl: INSTALL_URL, manageUrl: null },
};

const connected: WorkspaceRepository = {
  repository: null,
  github: { connected: true, installUrl: null, manageUrl: MANAGE_URL },
};

const bound: WorkspaceRepository = {
  repository: {
    bindingId: "rpb_0a1b2c",
    owner: "acme",
    name: "platform",
    fullName: "acme/platform",
    defaultRef: "main",
    htmlUrl: "https://github.com/acme/platform",
    boundAt: "2026-09-16T10:00:00.000Z",
  },
  github: { connected: true, installUrl: null, manageUrl: MANAGE_URL },
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

/** The shell as a person meets it: the sidebar header carries the control, the dialog answers it. */
function Shell({ container }: { container?: HTMLElement } = {}) {
  const data = shellData();
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <SidebarHeader data={data} />
        <WorkspaceSettingsDialog data={data} />
      </ShellStateProvider>
    </IntlProvider>,
    container ? { container } : undefined,
  );
}

async function openSettings(container?: HTMLElement) {
  const user = userEvent.setup();
  Shell({ container });
  await user.click(screen.getByTestId("open-workspace-settings"));
  return {
    user,
    dialog: await screen.findByTestId("workspace-settings-dialog"),
  };
}

// ShellStateProvider reads the theme from a media query jsdom does not have.
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

beforeEach(() => {
  nav.pathname = "/acme/core-platform";
  nav.query = "";
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.refresh.mockReset();
  readWorkspaceRepository.mockReset();
  listInstallationRepositories.mockReset();
  bindWorkspaceRepository.mockReset();
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

describe("the control that opens it", () => {
  it("sits beside the workspace tile and reads for the workspace in the URL", async () => {
    await openSettings();
    await waitFor(() => {
      expect(readWorkspaceRepository).toHaveBeenCalledWith(
        "acme",
        "core-platform",
      );
    });
  });

  it("reads nothing until a person opens it: the list is a live GitHub call", () => {
    Shell();
    expect(readWorkspaceRepository).not.toHaveBeenCalled();
    expect(listInstallationRepositories).not.toHaveBeenCalled();
  });

  it("is absent with no workspace to settle, and so is the dialog (negative)", () => {
    nav.pathname = "/acme";
    render(
      <IntlProvider>
        <ShellStateProvider>
          <SidebarHeader
            data={shellData({
              context: { ok: false, reason: "error", code: "x", status: 503 },
            })}
          />
          <WorkspaceSettingsDialog
            data={shellData({
              context: { ok: false, reason: "error", code: "x", status: 503 },
            })}
          />
        </ShellStateProvider>
      </IntlProvider>,
    );
    expect(screen.queryByTestId("open-workspace-settings")).toBeNull();
  });
});

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

  it("offers the App's install door rather than a picker that could only refuse", async () => {
    await openSettings();
    const install = await screen.findByTestId("workspace-github-install");
    expect(install).toHaveAttribute("href", INSTALL_URL);
    expect(install).toHaveAttribute("rel", "noopener noreferrer");
    expect(listInstallationRepositories).not.toHaveBeenCalled();
  });

  // A deployment with no App configured has no door to offer. Saying so beats
  // a button that goes nowhere.
  it("says the App is unconfigured instead of rendering a dead button (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: null,
        github: { connected: false, installUrl: null, manageUrl: null },
      },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-github-unconfigured"),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-install")).toBeNull();
  });

  it("refuses to link a URL that is not a page on github.com (negative)", async () => {
    readWorkspaceRepository.mockResolvedValue({
      ok: true,
      value: {
        repository: null,
        github: {
          connected: false,
          installUrl: "https://github.com.evil.example/apps/oxagen",
          manageUrl: null,
        },
      },
    });
    await openSettings();
    expect(
      await screen.findByTestId("workspace-github-unconfigured"),
    ).toBeTruthy();
  });
});

describe("picking the main repository", () => {
  beforeEach(() => {
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
  });

  it("lists exactly the repositories the installation reaches, with their default branch", async () => {
    await openSettings();
    expect(
      await screen.findByTestId("workspace-repository-picker"),
    ).toBeTruthy();
    expect(listInstallationRepositories).toHaveBeenCalledWith(
      "acme",
      "core-platform",
    );
    expect(screen.getByText("acme/platform")).toBeTruthy();
    expect(screen.getByText("acme/docs-site")).toBeTruthy();
    expect(screen.getByText("default branch trunk")).toBeTruthy();
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

  it("filters by name, and says so when nothing matches (negative)", async () => {
    const { user } = await openSettings();
    await screen.findByTestId("workspace-repository-picker");
    await user.type(screen.getByTestId("workspace-repository-filter"), "docs");
    expect(screen.queryByText("acme/platform")).toBeNull();
    expect(screen.getByText("acme/docs-site")).toBeTruthy();

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
        github: { connected: true, installUrl: null, manageUrl: null },
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

  // ARCHITECTURE.md §1.2, the phone shell: a dialog on a phone is a sheet from
  // the bottom edge, not a centred desktop modal with viewport margins.
  it("presents as a bottom sheet on a phone", async () => {
    const phone = phoneWidth();
    try {
      const { dialog } = await openSettings(phone.container);
      const style = getComputedStyle(dialog);
      expect(dialog.dataset.sheet).toBe("");
      expect(style.width).toBe("100%");
      expect(dialog.querySelector("[data-sheet-handle]")).not.toBeNull();
      expect(dialog.querySelector("[data-sheet-footer]")).not.toBeNull();
    } finally {
      phone.restore();
    }
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
  it("opens on ?settings=repository, acknowledges the install, and drops the query", async () => {
    nav.query = "settings=repository&github=connected";
    readWorkspaceRepository.mockResolvedValue({ ok: true, value: connected });
    Shell();

    expect(await screen.findByTestId("workspace-settings-dialog")).toBeTruthy();
    expect(screen.getByTestId("workspace-github-connected")).toBeTruthy();
    expect(nav.replace).toHaveBeenCalledWith("/acme/core-platform");
  });

  it("does not open, or acknowledge anything, on an ordinary URL (negative)", async () => {
    Shell();
    await waitFor(() => {
      expect(screen.queryByTestId("workspace-settings-dialog")).toBeNull();
    });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("opens without the acknowledgement when the query names no install (negative)", async () => {
    nav.query = "settings=repository";
    Shell();
    expect(await screen.findByTestId("workspace-settings-dialog")).toBeTruthy();
    expect(screen.queryByTestId("workspace-github-connected")).toBeNull();
  });
});
