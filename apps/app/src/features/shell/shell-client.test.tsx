// @vitest-environment jsdom
// The client shell against the viewer the layout resolved: the sidebar, top
// bar, the organization and workspace tiles, command menu, user menu and
// <MobileNav>, driven the way an operator drives them, and the chrome rev1
// does not render (ARCHITECTURE.md §1.2) asserted absent.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
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
import { expectNoAxe } from "@/test/expect-no-axe";
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";

import { accountOperations } from "./account-operations";
import { recoveryCodeVault } from "./recovery-code-vault";
import { shellData } from "./shell.builders";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
  query: "",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname.split("?")[0],
  // Two conventions meet here: a case that sets `nav.query`, and one that puts
  // the query on `nav.pathname`. Both are read so neither lane's tests break.
  useSearchParams: () =>
    new URLSearchParams(nav.query || (nav.pathname.split("?")[1] ?? "")),
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    refresh: nav.refresh,
  }),
}));

// The Account dialog's tabs read on open; the shell test only needs them to
// answer, not what they answer with (account-dialog.test.tsx covers that).
const liveSignOut = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const liveRegenerateBackupCodes = vi.hoisted(() =>
  vi.fn((): Promise<unknown> => Promise.resolve({ ok: false })),
);
vi.mock("./session-client", () => ({
  liveSignOut,
  liveListSessions: () => Promise.resolve({ ok: true, sessions: [] }),
  liveRevokeSession: () => Promise.resolve(true),
  liveRegenerateBackupCodes,
}));
vi.mock("./account-actions", () => ({
  updateProfile: vi.fn(),
  readPreferences: () =>
    Promise.resolve({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "system" },
    }),
  savePreferences: vi.fn(),
  requestExport: vi.fn(),
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

vi.mock("@oxagen/ui", () => ({
  OxagenWordmark: () => <svg aria-hidden="true" />,
}));

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  accountOperations.resetForTests();
  recoveryCodeVault.resetForTests();
  nav.pathname = "/acme/core-platform";
  nav.query = "";
  nav.push.mockReset();
  nav.replace.mockReset();
  nav.refresh.mockReset();
});

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
  document.cookie = "theme=; Max-Age=0; Path=/";
  delete document.documentElement.dataset.theme;
});

function renderShell(data: ShellData) {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{
        ...en,
        ...shellMessages,
        ...uiMessages,
      }}
    >
      <ShellClient data={data} />
      <main id="main" />
    </NextIntlClientProvider>,
  );
}

describe("the shell on /{org}/{ws}", () => {
  it("renders the sidebar, top bar, bottom bar and the assistant, and none of the chrome rev1 drops (negative)", () => {
    renderShell(shellData());
    expect(
      screen.getByRole("complementary", { name: "Sidebar" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("banner", { name: "Top bar" })).toBeInTheDocument();
    expect(screen.getByTestId("mobile-nav")).toBeInTheDocument();
    expect(screen.getByTestId("user-menu-trigger")).toBeInTheDocument();
    // The in-app agent is back on its #2968 lane, so the launcher and its
    // flyout host render — the host always mounted, and `inert` until opened.
    const launcher = screen.getByTestId("assistant-launcher");
    expect(launcher).toBeInTheDocument();
    // What it opens is a dialog, and it says so before it is pressed.
    expect(launcher).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute("inert");
    // The bell and the approvals button sit in the top bar (fleet.md
    // "Shell"); the assistant has no top bar button, only the launcher.
    const top = screen.getByRole("banner", { name: "Top bar" });
    expect(
      within(top).getByRole("button", { name: /^Notifications/ }),
    ).toBeInTheDocument();
    expect(
      within(top).getByRole("button", { name: /^Approvals/ }),
    ).toHaveAttribute("aria-controls", "apdrawer");
    expect(
      within(top).queryByRole("button", { name: /assistant/i }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).queryByText(/needs attention/)).toBeNull();
    expect(within(main).queryByText(/\d+ items?/)).toBeNull();
  });
});

// The trigger read the name and the email and nothing else, so `viewer.avatarUrl`
// had no branch that could draw it: the Account dialog's avatar field was
// write-only from the chrome's point of view, and a reload did not help either
// because the value arrived and was dropped at the last step.
describe("the user-menu trigger", () => {
  function withAvatar(avatarUrl: string | null) {
    return shellData({ viewer: { ...shellData().viewer, avatarUrl } });
  }

  it("draws the persisted image avatar, not the initials", () => {
    renderShell(withAvatar("https://cdn.example/marcus.png"));
    const avatar = screen.getByTestId("user-menu-avatar");
    expect(avatar.dataset.avatar).toBe("image");
    expect(avatar).toHaveAttribute("src", "https://cdn.example/marcus.png");
    expect(screen.getByTestId("user-menu-trigger").textContent).toBe("");
  });

  it("draws a persisted designed avatar, not the initials", () => {
    renderShell(
      withAvatar('avatar:v1:{"kind":"icon","icon":"rocket","tone":"solid"}'),
    );
    const avatar = screen.getByTestId("user-menu-avatar");
    expect(avatar.dataset.avatar).toBe("icon");
    expect(avatar.dataset.icon).toBe("rocket");
    expect(avatar.textContent).toBe("");
  });

  it("draws it at the trigger's 30px, not the editor preview's", () => {
    renderShell(
      withAvatar('avatar:v1:{"kind":"icon","icon":"rocket","tone":"solid"}'),
    );
    expect(screen.getByTestId("user-menu-avatar").style.width).toBe("30px");
  });

  it("falls back to initials when no avatar is set, or the stored value is malformed (negative)", () => {
    renderShell(withAvatar(null));
    expect(screen.getByTestId("user-menu-avatar").dataset.avatar).toBe(
      "initials",
    );
    expect(screen.getByTestId("user-menu-trigger").textContent).toBe("MB");
    cleanup();

    renderShell(withAvatar("javascript:alert(1)"));
    expect(screen.getByTestId("user-menu-avatar").dataset.avatar).toBe(
      "initials",
    );
    expect(screen.getByTestId("user-menu-trigger").textContent).toBe("MB");
  });

  it("names the person in the trigger's label whatever the avatar is", () => {
    renderShell(withAvatar("https://cdn.example/marcus.png"));
    expect(screen.getByTestId("user-menu-trigger")).toHaveAttribute(
      "aria-label",
      "User menu for Marcus Bell",
    );
  });
});

describe("sidebar", () => {
  it("renders exactly the mockup's ten links, Runtimes among them, and the current page", () => {
    renderShell(shellData());
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const main = within(sidebar).getByRole("navigation", { name: "Main" });
    const links = within(main).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Fleet", "/acme/core-platform"],
      ["Agents", "/acme/core-platform/agents"],
      ["Tools", "/acme/core-platform/tools"],
      ["Steering", "/acme/core-platform/steering"],
      ["Runtimes", "/acme/core-platform/runtimes"],
      ["Repositories", "/acme/core-platform/repositories"],
      ["Spend", "/acme/core-platform/spend"],
      ["Organization", "/acme"],
      ["Billing", "/acme/billing"],
      ["Audit", "/acme/audit"],
    ]);
    for (const link of links)
      expect(link.getAttribute("href")).not.toMatch(
        /^\/acme\/core-platform\/(ontology|skills)(\/|$)/,
      );
    expect(within(main).getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("on an organization page points the workspace links at the first workspace shell.context lists", () => {
    nav.pathname = "/acme/billing";
    renderShell(shellData());
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link")).toHaveLength(10);
    expect(within(main).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(main).getByRole("link", { name: "Tools" })).toHaveAttribute(
      "href",
      "/acme/core-platform/tools",
    );
    expect(screen.getByTestId("workspace-switcher")).toHaveTextContent(
      "Core platform",
    );
  });

  it("carries only the organization section on an organization page when shell.context failed (negative)", () => {
    nav.pathname = "/acme/billing";
    renderShell(
      shellData({
        context: { ok: false, reason: "error", code: "down", status: 503 },
      }),
    );
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(main)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Organization", "Billing", "Audit"]);
    expect(screen.queryByTestId("workspace-switcher")).toBeNull();
  });
});

describe("top bar", () => {
  it("shows breadcrumbs for the current page", () => {
    nav.pathname = "/acme/core-platform/runs/run_01K5RS7M2E8FJ3QW";
    renderShell(shellData());
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs).getByRole("link", { name: "Acme Robotics" }),
    ).toHaveAttribute("href", "/acme");
    expect(
      within(crumbs).getByRole("link", { name: "Core platform" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    expect(within(crumbs).getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(within(crumbs).getByText("run_01K5RS7M2E8FJ3QW")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

describe("command menu", () => {
  it("opens with ⌘K over the static routes only, filters, moves with the arrows and navigates on Enter", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.keyboard("{Meta>}k{/Meta}");
    const menu = await screen.findByTestId("command-menu");
    const input = within(menu).getByRole("combobox", { name: "Go to a page" });
    expect(
      within(menu)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Fleet",
      "Agents",
      "Tools",
      "Steering",
      "Runtimes",
      "Repositories",
      "Spend",
      "Organization",
      "Roles",
      "API keys",
      "Model funding",
      "Single sign-on",
      "Billing",
      "Audit",
      "Create anything",
      "New agent",
      "Add a skill",
      "Write a context record",
    ]);
    expect(within(menu).queryAllByRole("group")).toEqual([]);
    await user.type(input, "api keys");
    expect(
      within(menu)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["API keys"]);
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(nav.push).toHaveBeenCalledWith("/acme/api-keys");
    await waitFor(() => {
      expect(screen.queryByTestId("command-menu")).toBeNull();
    });
  });

  it("opens with Ctrl+K as well, and not for K with Shift or Alt, ⌘ with another key, or K alone (negative)", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    for (const chord of [
      "{Control>}{Shift>}k{/Shift}{/Control}",
      "{Control>}{Alt>}k{/Alt}{/Control}",
      "{Meta>}j{/Meta}",
      "k",
    ]) {
      await user.keyboard(chord);
      expect(screen.queryByTestId("command-menu")).toBeNull();
    }
    await user.keyboard("{Control>}K{/Control}");
    expect(await screen.findByTestId("command-menu")).toBeInTheDocument();
  });

  it("opens from the search button, says when nothing matches, and opens a clicked route", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "Search or run an action" }),
    );
    const menu = await screen.findByTestId("command-menu");
    const input = within(menu).getByRole("combobox");
    await user.type(input, "zebra");
    expect(within(menu).getByRole("status")).toHaveTextContent(
      "Nothing matches “zebra”.",
    );
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Enter}");
    expect(nav.push).not.toHaveBeenCalled();
    await user.clear(input);
    const billing = within(menu).getByRole("option", { name: "Billing" });
    await user.hover(billing);
    expect(billing).toHaveAttribute("aria-selected", "true");
    await user.click(billing);
    expect(nav.push).toHaveBeenCalledWith("/acme/billing");
  });
});

describe("user menu", () => {
  it("names the viewer and offers the mockup's items, and no onboarding demo (negative)", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveTextContent("Marcus Bell");
    expect(menu).toHaveTextContent("marcus.bell@acme.example");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent.replace(/now .*$/, "").trim()),
    ).toEqual([
      "Account",
      "Preferences",
      "Security and sessions",
      "Privacy and data",
      "Switch theme",
      "Sign out",
    ]);
    expect(within(menu).queryByText(/onboarding/i)).toBeNull();
  });

  it("opens the Account dialog on the tab each link names", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    for (const [testId, tab] of [
      ["open-security", "security"],
      ["open-privacy", "privacy"],
      ["open-preferences", "preferences"],
      ["open-account", "profile"],
    ] as const) {
      await user.click(
        screen.getByRole("button", { name: "User menu for Marcus Bell" }),
      );
      await user.click(
        within(await screen.findByRole("menu")).getByTestId(testId),
      );
      const dialog = await screen.findByTestId("account-dialog");
      expect(within(dialog).getByTestId(`account-tab-${tab}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await user.keyboard("{Escape}");
    }
  });

  it("signs out through Better Auth and lands on the sign-in page", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    await user.click(
      within(await screen.findByRole("menu")).getByTestId("sign-out"),
    );
    expect(liveSignOut).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith("/login");
  });

  // Better Auth reports a refused sign-out by resolving with `error` set, not
  // by rejecting, and the menu used to navigate from `finally` regardless. So
  // a sign-out that never reached the server looked exactly like one that
  // worked: the page left, the person believed the session was closed, and the
  // cookie was still valid. Back would have put them into the app as
  // themselves. This is the control people reach for on a machine they do not
  // trust, so it may not claim an outcome it did not get.
  it("stays put and says so when sign-out did not go through (negative)", async () => {
    liveSignOut.mockResolvedValueOnce(false);
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    const menu = within(await screen.findByRole("menu"));
    await user.click(menu.getByTestId("sign-out"));

    expect(liveSignOut).toHaveBeenCalledTimes(1);
    expect(nav.replace).not.toHaveBeenCalled();
    // Said where the person is looking, inside the item itself, because a
    // paragraph beside it would break `role="menu"`'s allowed children.
    expect(await screen.findByTestId("sign-out-failed")).toHaveTextContent(
      "still open",
    );
    // And announced, from a live region outside the menu.
    expect(screen.getByRole("alert")).toHaveTextContent("still open");

    // And the press can be repeated, rather than the menu being left dead.
    liveSignOut.mockResolvedValueOnce(true);
    await user.click(
      within(await screen.findByRole("menu")).getByTestId("sign-out"),
    );
    expect(nav.replace).toHaveBeenCalledWith("/login");
  });

  // A thrown call is the same outcome as a refused one: the session may still
  // be open, so nothing may claim it closed.
  it("stays put when the sign-out call throws (negative)", async () => {
    liveSignOut.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    await user.click(
      within(await screen.findByRole("menu")).getByTestId("sign-out"),
    );
    expect(nav.replace).not.toHaveBeenCalled();
    expect(await screen.findByTestId("sign-out-failed")).toBeTruthy();
  });

  // Sign out leaves the shell through a client-side `replace`, which runs no
  // `beforeunload`. With a recovery-code rotation in flight that would drop
  // the only copy of the new set. This PR holds the dialog itself non-
  // dismissible while codes are unacknowledged ("unacknowledged codes hold
  // the dialog and tabs in place" — see the PR summary), so Escape no longer
  // reaches the user menu at all: sign out is not merely intercepted, it is
  // unreachable. That is a stronger guarantee than the menu-level redirect
  // this test originally exercised, so the assertions below match the dialog
  // hold rather than a click path the hold now blocks.
  it("holds sign out while a recovery-code rotation is in flight", async () => {
    liveSignOut.mockClear();
    liveRegenerateBackupCodes.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    await user.click(
      within(await screen.findByRole("menu")).getByTestId("open-security"),
    );
    await user.click(await screen.findByTestId("account-codes-open"));
    await user.type(screen.getByTestId("account-codes-password"), "hunter2");
    await user.click(screen.getByTestId("account-codes-confirm"));
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("account-codes-confirm")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Escape did not close the dialog, so the rest of the shell — the user
    // menu included — stays inert and sign out cannot be reached.
    expect(
      screen.queryByRole("button", { name: "User menu for Marcus Bell" }),
    ).toBeNull();
    expect(liveSignOut).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();

    // A new organization layout mounts a fresh shell in the same browser
    // realm. The vault still has the rotation at stake, so the fresh mount
    // opens straight back to the held dialog rather than a clean shell a
    // person could sign out from.
    cleanup();
    renderShell(shellData());
    const dialog = await screen.findByTestId("account-dialog");
    expect(within(dialog).getByTestId("account-tab-security")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "User menu for Marcus Bell" }),
    ).toBeNull();
    expect(liveSignOut).not.toHaveBeenCalled();
  });

  it("switches theme: light, dark, system", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("names a viewer with no recorded name by their email", () => {
    renderShell(
      shellData({
        viewer: {
          ...shellData().viewer,
          name: null,
          email: "dana@acme.example",
          avatarUrl: null,
        },
      }),
    );
    expect(
      screen.getByRole("button", { name: "User menu for dana@acme.example" }),
    ).toHaveTextContent("D");
  });
});
