// @vitest-environment jsdom
// The client shell against the viewer the layout resolved: the sidebar, top
// bar, the organization and workspace tiles, command menu, user menu and
// <MobileNav>, driven the way an operator drives them, and the chrome rev1
// does not render (ARCHITECTURE.md §1.2) asserted absent.
import {
  act,
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
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import { MobileNav } from "./mobile-nav";
import { shellData } from "./shell.builders";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
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
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
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
  nav.push.mockReset();
});

afterEach(() => {
  cleanup();
  document.cookie = "theme=; Max-Age=0; Path=/";
  delete document.documentElement.dataset.theme;
});

function renderShell(data: ShellData) {
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...en, ...shellMessages }}
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

describe("sidebar", () => {
  it("renders the baseline sections with Agent IAM naming and the current page", () => {
    renderShell(shellData());
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    const main = within(sidebar).getByRole("navigation", { name: "Main" });
    const links = within(main).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/acme/core-platform",
      "/acme/core-platform/agents",
      "/acme/core-platform/tools",
      "/acme/core-platform/ontology",
      "/acme/core-platform/steering",
      "/acme/core-platform/spend",
      "/acme",
      "/acme/billing",
      "/acme/audit",
    ]);
    expect(
      within(main).getByRole("link", { name: "Agent IAM" }),
    ).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("carries only the organization section on an organization page: no workspace is known without a list", () => {
    nav.pathname = "/acme/billing";
    renderShell(shellData());
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(main).queryByRole("link", { name: "Tools" })).toBeNull();
    expect(screen.queryByTestId("workspace-switcher")).toBeNull();
  });
});

describe("organization and workspace tiles", () => {
  it("show the current organization from the viewer and the current workspace from the URL, with nothing to switch to (negative)", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    const org = screen.getByRole("group", { name: "Organization" });
    expect(org).toHaveTextContent("Acme Robotics");
    expect(org).toHaveTextContent("acme");
    const ws = screen.getByRole("group", { name: "Workspace" });
    expect(ws).toHaveTextContent("core-platform");
    expect(within(org).queryByRole("button")).toBeNull();
    expect(within(ws).queryByRole("button")).toBeNull();
    await user.click(org);
    await user.click(ws);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
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
      "Ontology",
      "Steering",
      "Spend",
      "Organization",
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
  it("names the viewer and switches theme: light, dark, system; nothing else is offered (negative)", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", { name: "User menu for Marcus Bell" }),
    );
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveTextContent("marcus.bell@acme.example");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1);
    await user.click(within(menu).getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("names a viewer with no recorded name by their email", () => {
    renderShell(
      shellData({ viewer: { name: null, email: "dana@acme.example" } }),
    );
    expect(
      screen.getByRole("button", { name: "User menu for dana@acme.example" }),
    ).toHaveTextContent("D");
  });
});

describe("phone navigation", () => {
  it("offers the bottom bar and opens the drawer from More and from the menu button", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    const bar = screen.getByTestId("mobile-nav");
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Fleet", "Agent IAM", "Tools", "Spend"]);
    await user.click(within(bar).getByRole("button", { name: "More" }));
    const drawer = await screen.findByTestId("nav-drawer");
    await user.click(within(drawer).getByRole("link", { name: "Ontology" }));
    await waitFor(() => {
      expect(screen.queryByTestId("nav-drawer")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const again = await screen.findByTestId("nav-drawer");
    await user.click(
      within(again).getByRole("button", { name: "Close navigation" }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("nav-drawer")).toBeNull();
    });
  });

  it("falls back to organization pages when there is no workspace", () => {
    const onMore = vi.fn();
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{ ...en, ...shellMessages }}
      >
        <MobileNav
          items={[{ key: "billing", href: "/acme/billing" }]}
          pathname="/acme/billing"
          onMore={onMore}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    act(() => {
      screen.getByRole("button", { name: "More" }).click();
    });
    expect(onMore).toHaveBeenCalled();
  });
});
