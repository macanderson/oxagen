// @vitest-environment jsdom
// The client shell against the built context read: the sidebar, top bar,
// switchers, command menu, user menu and <MobileNav>, driven the way an
// operator drives them, and the chrome rev1 does not render (ARCHITECTURE.md
// §1.2) asserted absent.
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
import { readOk } from "@/data/not-backed";
import { liveShell } from "@/data/adapters/live/shell";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { loadShellData } from "./load";
import { MobileNav } from "./mobile-nav";
import { SHELL_ORG_ID, shellData } from "./shell.builders";
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

const ORG_SCOPE = {
  orgId: SHELL_ORG_ID,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

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
    expect(within(sidebar).getByText("shared plane")).toBeInTheDocument();
  });

  it("points the workspace section at the first workspace on an organization page", () => {
    nav.pathname = "/acme/billing";
    renderShell(shellData());
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(main).getByRole("link", { name: "Tools" })).toHaveAttribute(
      "href",
      "/acme/core-platform/tools",
    );
  });

  it("degrades to the slug, without switchers or the plane line, when the context is not wired", async () => {
    const load = await loadShellData(liveShell, {
      org: "acme",
      scope: ORG_SCOPE,
      userId: "",
    });
    if (load.kind !== "ok") throw new Error("unexpected not found");
    renderShell(load.data);
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(
      within(sidebar).queryByRole("button", { name: /Switch organization/ }),
    ).toBeNull();
    expect(within(sidebar).getByText("acme")).toBeInTheDocument();
    expect(within(sidebar).queryByText(/plane/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "User menu" }),
    ).toBeInTheDocument();
  });
});

describe("switchers", () => {
  it("lists workspaces with their recorded agent count and links each to its Fleet", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", {
        name: "Switch workspace, current Core platform",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Switch workspace",
    });
    const finops = within(dialog).getByRole("link", { name: /FinOps/ });
    expect(finops).toHaveAttribute("href", "/acme/finops");
    expect(finops).toHaveTextContent("4 agents");
    expect(
      within(dialog).getByRole("link", { name: /Core platform/ }),
    ).toHaveAttribute("aria-current", "page");
    await user.click(finops);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Switch workspace" }),
      ).toBeNull();
    });
  });

  it("searches organizations", async () => {
    const user = userEvent.setup();
    renderShell(shellData());
    await user.click(
      screen.getByRole("button", {
        name: "Switch organization, current Acme Robotics",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Switch organization",
    });
    await user.type(
      within(dialog).getByRole("searchbox", { name: "Search organizations" }),
      "globex",
    );
    expect(
      within(dialog).getByText("No organization matches that search."),
    ).toBeInTheDocument();
    await user.clear(within(dialog).getByRole("searchbox"));
    await user.click(
      within(dialog).getByRole("link", { name: /Acme Robotics/ }),
    );
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
      "Roles",
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

describe("readOk guard", () => {
  it("renders the shell for a context without workspaces", () => {
    const data = shellData();
    if (!data.context.ok) throw new Error("built context failed");
    renderShell({
      ...data,
      context: readOk({ ...data.context.value, workspaces: [] }),
    });
    expect(
      screen.queryByRole("button", { name: /Switch workspace/ }),
    ).toBeNull();
    expect(
      within(screen.getByTestId("mobile-nav"))
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Organization", "Billing", "Audit"]);
  });
});
