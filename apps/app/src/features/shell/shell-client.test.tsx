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
import workspaceSettingsMessages from "../../../messages/workspace-settings.json";

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
        ...workspaceSettingsMessages,
      }}
    >
      <ShellClient data={data} />
      <main id="main" />
    </NextIntlClientProvider>,
  );
}

describe("the shell on /{org}/{ws}", () => {
  it("renders the sidebar, top bar and bottom bar, and none of the chrome rev1 drops (negative)", () => {
    renderShell(shellData());
    expect(
      screen.getByRole("complementary", { name: "Sidebar" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("banner", { name: "Top bar" })).toBeInTheDocument();
    expect(screen.getByTestId("mobile-nav")).toBeInTheDocument();
    expect(screen.getByTestId("user-menu-trigger")).toBeInTheDocument();
    // The bell, the assistant, the Account dialog and nav counts.
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assistant" })).toBeNull();
    expect(screen.queryByTestId("assistant-launcher")).toBeNull();
    expect(screen.queryByTestId("assistant-flyout")).toBeNull();
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
    return shellData({
      viewer: {
        name: "Marcus Bell",
        email: "marcus.bell@acme.example",
        avatarUrl,
      },
    });
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
      withAvatar('avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}'),
    );
    const avatar = screen.getByTestId("user-menu-avatar");
    expect(avatar.dataset.avatar).toBe("designed");
    expect(avatar.textContent).toBe("🦊");
  });

  it("draws it at the trigger's size, not the editor preview's", () => {
    renderShell(
      withAvatar('avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}'),
    );
    const avatar = screen.getByTestId("user-menu-avatar");
    expect(avatar.className).toContain("size-8");
    expect(avatar.className).not.toContain("size-13");
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
  it("renders exactly the mockup's eight links with Agent IAM naming and the current page", () => {
    renderShell(shellData());
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const main = within(sidebar).getByRole("navigation", { name: "Main" });
    const links = within(main).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Fleet", "/acme/core-platform"],
      ["Agent IAM", "/acme/core-platform/agents"],
      ["Tools", "/acme/core-platform/tools"],
      ["Skills", "/acme/core-platform/skills"],
      ["Steering", "/acme/core-platform/steering"],
      ["Spend", "/acme/core-platform/spend"],
      ["Organization", "/acme"],
      ["Billing", "/acme/billing"],
      ["Audit", "/acme/audit"],
    ]);
    for (const link of links)
      expect(link.getAttribute("href")).not.toMatch(
        /^\/acme\/core-platform\/ontology(\/|$)/,
      );
    expect(
      within(main).getByRole("link", { name: "Agent IAM" }),
    ).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("on an organization page points the workspace links at the first workspace shell.context lists", () => {
    nav.pathname = "/acme/billing";
    renderShell(shellData());
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link")).toHaveLength(9);
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
      "Agent IAM",
      "Tools",
      "Skills",
      "Steering",
      "Spend",
      "Organization",
      "Roles",
      "API keys",
      "Billing",
      "Audit",
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
    await user.click(screen.getByRole("button", { name: "Go to a page" }));
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
  it("names the viewer, opens Account and switches theme: light, dark, system; nothing else is offered (negative)", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveTextContent("marcus.bell@acme.example");
    // Account and Switch theme, and nothing else: the dialog spec App. F folds
    // the account pages into is reached from here.
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).getByTestId("open-account")).toBeTruthy();
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
        viewer: { name: null, email: "dana@acme.example", avatarUrl: null },
      }),
    );
    expect(
      screen.getByRole("button", { name: "User menu for dana@acme.example" }),
    ).toHaveTextContent("D");
  });
});
