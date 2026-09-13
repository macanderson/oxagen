// @vitest-environment jsdom
// The client shell against the fixture reads: the sidebar, top bar, switchers,
// command menu, notifications, Account dialog, assistant flyout and
// <MobileNav>, driven the way an operator drives them.
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
import { denied, notBacked, readError, readOk } from "@/data/not-backed";
import type { ShellSwitches } from "@/data/adapters/fixture/state";
import { testFixtureShell } from "@/data/adapters/fixture/testing";
import { liveShell } from "@/data/adapters/live/shell";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { FIXTURE_USER } from "@/server/fixture-session";
import { loadShellData } from "./load";
import { MobileNav } from "./mobile-nav";
import { ShellClient } from "./shell-client";
import type { ShellData } from "./shell-data";

const nav = vi.hoisted(() => ({
  pathname: "/acme/core-platform",
  search: "",
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
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
  nav.search = "";
  nav.push.mockReset();
  nav.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  document.cookie = "theme=; Max-Age=0; Path=/";
  delete document.documentElement.dataset.theme;
});

const ORG_SCOPE = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};

async function fixtureData(switches?: ShellSwitches): Promise<ShellData> {
  const load = await loadShellData(testFixtureShell(switches), {
    org: "acme",
    scope: ORG_SCOPE,
    userId: FIXTURE_USER.id,
  });
  if (load.kind !== "ok") throw new Error("fixture organization not found");
  return load.data;
}

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

describe("sidebar", () => {
  it("renders the baseline sections with Agent IAM naming, counts and the current page", async () => {
    renderShell(await fixtureData());
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
      within(main).getByRole("link", { name: /Agent IAM/ }),
    ).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: /Fleet/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The count is the seed's pending approvals in core-platform, what Fleet lists.
    expect(within(main).getByRole("link", { name: /Fleet/ })).toHaveTextContent(
      "1 needs attention",
    );
    expect(
      within(sidebar).getByText("38 agents · shared plane"),
    ).toBeInTheDocument();
  });

  it("points the workspace section at the first workspace on an organization page", async () => {
    nav.pathname = "/acme/billing";
    renderShell(await fixtureData());
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: /Billing/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(main).getByRole("link", { name: /Tools/ })).toHaveAttribute(
      "href",
      "/acme/core-platform/tools",
    );
  });

  it("degrades to the slug, without counts or switchers, when the context is not wired", async () => {
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
    expect(screen.getByTestId("assistant-launcher")).toHaveTextContent(
      "engine down",
    );
  });
});

describe("switchers", () => {
  it("lists workspaces and links each to its Fleet", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    await user.click(
      screen.getByRole("button", {
        name: "Switch workspace, current Core platform",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Switch workspace",
    });
    expect(
      within(dialog).getByRole("link", { name: /FinOps/ }),
    ).toHaveAttribute("href", "/acme/finops");
    expect(
      within(dialog).getByRole("link", { name: /Core platform/ }),
    ).toHaveAttribute("aria-current", "page");
    await user.click(within(dialog).getByRole("link", { name: /FinOps/ }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Switch workspace" }),
      ).toBeNull();
    });
  });

  it("searches organizations", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
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
  it("shows breadcrumbs for the current page", async () => {
    nav.pathname = "/acme/core-platform/runs/run_01K5RS7M2E8FJ3QW";
    renderShell(await fixtureData());
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
  it("opens with ⌘K, filters, moves with the arrows and navigates on Enter", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    await user.keyboard("{Meta>}k{/Meta}");
    const menu = await screen.findByTestId("command-menu");
    const input = within(menu).getByRole("combobox", { name: /Search runs/ });
    expect(within(menu).getAllByRole("option").length).toBeGreaterThan(20);
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

  it("opens from the search button, says when nothing matches, and opens a clicked run", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
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
    const run = within(menu).getByRole("option", {
      name: /run_01K5RQ4B9C7XTN2P/,
    });
    await user.hover(run);
    expect(run).toHaveAttribute("aria-selected", "true");
    await user.click(run);
    expect(nav.push).toHaveBeenCalledWith(
      "/acme/core-platform/runs/run_01K5RQ4B9C7XTN2P",
    );
  });
});

describe("notifications", () => {
  it("lists notifications newest first with the unread count", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    const trigger = screen.getByTestId("notifications-trigger");
    expect(trigger).toHaveAccessibleName("Notifications, 3 unread");
    await user.click(trigger);
    const popover = await screen.findByTestId("notifications-popover");
    const items = within(popover).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent("Approval waiting");
    expect(within(popover).getByText("3 unread")).toBeInTheDocument();
    expect(
      within(popover).getByRole("link", { name: "Open run_01K5RS7M2E8FJ3QW" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/run_01K5RS7M2E8FJ3QW");
  });

  it.each([
    ["empty", "notifications-empty", "No notifications"],
    ["error", "notifications-error", "notification_store_unavailable"],
    ["not_backed", "notifications-not_backed", "does not read it yet"],
  ] as const)("renders the %s state", async (state, testId, text) => {
    const user = userEvent.setup();
    renderShell(await fixtureData({ engine: "up", notifications: state }));
    await user.click(screen.getByTestId("notifications-trigger"));
    expect(await screen.findByTestId(testId)).toHaveTextContent(text);
  });

  it("draws a recorded row with no severity and no body as a plain bell, never a guessed tone", async () => {
    const user = userEvent.setup();
    const data = {
      ...(await fixtureData()),
      notifications: readOk({
        items: [
          {
            id: "ntf_live01",
            kind: "run",
            severity: null,
            title: "Run finished",
            body: null,
            unread: true,
            at: "2026-09-11T09:14:02.000Z",
            runId: null,
            ref: null,
          },
        ],
      }),
    };
    renderShell(data);
    await user.click(screen.getByTestId("notifications-trigger"));
    const popover = await screen.findByTestId("notifications-popover");
    const [item] = within(popover).getAllByRole("listitem");
    expect(item).toHaveTextContent("Run finished");
    expect(item).toHaveTextContent("run");
    const icon = item?.querySelector("svg");
    expect(icon).toHaveClass("text-muted-foreground");
    expect(icon?.getAttribute("class")).not.toMatch(
      /text-(success|info|warning|error)/,
    );
    expect(item?.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders the denied state", async () => {
    const user = userEvent.setup();
    const data = {
      ...(await fixtureData()),
      notifications: denied("notification.list"),
    };
    renderShell(data);
    await user.click(screen.getByTestId("notifications-trigger"));
    expect(await screen.findByTestId("notifications-denied")).toHaveTextContent(
      "notification.list",
    );
  });
});

describe("assistant flyout", () => {
  it("is inert until the sidebar launcher flies it out, and Escape closes it", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    const flyout = screen.getByTestId("assistant-flyout");
    expect(flyout).toHaveAttribute("inert");
    const launcher = screen.getByTestId("assistant-launcher");
    expect(launcher).toHaveTextContent("glm-flash · ready");
    await user.click(launcher);
    expect(flyout).not.toHaveAttribute("inert");
    expect(flyout).toHaveAttribute("data-state", "open");
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    expect(within(flyout).getByTestId("assistant-ready")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(flyout).getByRole("button", { name: "Close the assistant" }),
      ).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(flyout).toHaveAttribute("data-state", "closed");
  });

  it("shows the engine-down state from the port, with a retry that re-reads", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData({ engine: "down", notifications: "loaded" }));
    expect(screen.getByTestId("assistant-launcher")).toHaveTextContent(
      "engine down",
    );
    await user.click(screen.getByRole("button", { name: "Assistant" }));
    const down = screen.getByTestId("assistant-engine-down");
    expect(down).toHaveTextContent("The Stella engine is not answering");
    expect(down).toHaveTextContent("stella serve returned 503");
    expect(down).toHaveTextContent(
      "engine 0.31.4 · last healthy Sep 12, 09:02",
    );
    expect(
      screen.getByRole("textbox", { name: "Message the assistant" }),
    ).toBeDisabled();
    await user.click(within(down).getByRole("button", { name: "Retry" }));
    expect(nav.refresh).toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Close the assistant" }),
    );
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "data-state",
      "closed",
    );
  });

  it("names a failed health read as down, never ready", async () => {
    const user = userEvent.setup();
    const data = {
      ...(await fixtureData()),
      engine: readError("shell_assistant_engine_not_wired", 501),
    };
    renderShell(data);
    await user.click(screen.getByTestId("assistant-launcher"));
    const down = screen.getByTestId("assistant-engine-down");
    expect(down).toHaveTextContent(
      "shell_assistant_engine_not_wired (HTTP 501)",
    );
    expect(down).toHaveTextContent("last healthy time not recorded");
  });
});

describe("account menu and dialog", () => {
  it("opens each tab from the user menu", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    await user.click(
      screen.getByRole("button", { name: "Account menu for Marcus Bell" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Security and sessions" }),
    );
    const dialog = await screen.findByTestId("account-dialog");
    expect(
      within(dialog).getByRole("tab", { name: "Security" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(dialog).getByTestId("account-panel-security"),
    ).toHaveTextContent("this device");
    expect(
      within(dialog).getByText(/8 recovery codes unused/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("tab", { name: "Profile" }));
    expect(
      within(dialog).getByTestId("account-panel-profile"),
    ).toHaveTextContent("workspace.owner");
    expect(within(dialog).getByLabelText("Email")).toBeDisabled();

    await user.click(within(dialog).getByRole("tab", { name: "Privacy" }));
    const privacy = within(dialog).getByTestId("account-panel-privacy");
    expect(privacy).toHaveTextContent("7 years from the seal");
    expect(privacy).toHaveTextContent("shared · us-east-1");

    await user.click(within(dialog).getByRole("tab", { name: "Preferences" }));
    const select = within(dialog).getByTestId("theme-select");
    await user.selectOptions(select, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("theme=dark");
    await user.selectOptions(select, "system");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByTestId("account-dialog")).toBeNull();
    });
  });

  it("switches theme from the menu: light, dark, system", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    const menuTrigger = screen.getByRole("button", {
      name: "Account menu for Marcus Bell",
    });
    await user.click(menuTrigger);
    await user.click(await screen.findByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBe("light");
    await user.click(screen.getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await user.click(screen.getByTestId("switch-theme"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("opens from ?dialog=account&tab=…, and says so when the account cannot load", async () => {
    nav.search = "dialog=account&tab=privacy";
    const data = {
      ...(await fixtureData()),
      account: readError("shell_account_not_wired", 501),
    };
    renderShell(data);
    const dialog = await screen.findByTestId("account-dialog");
    expect(within(dialog).getByTestId("account-unavailable")).toHaveTextContent(
      "shell_account_not_wired",
    );
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("tab", { name: "Preferences" }));
    expect(within(dialog).getByTestId("theme-select")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Locale")).toBeNull();
  });

  it("labels an unknown viewer and a not-backed account honestly", async () => {
    nav.search = "dialog=account";
    const base = await loadShellData(liveShell, {
      org: "acme",
      scope: ORG_SCOPE,
      userId: "",
    });
    if (base.kind !== "ok") throw new Error("unexpected");
    renderShell({ ...base.data, account: notBacked("M1", "G15") });
    expect(
      screen.getByRole("button", { name: "Account menu", hidden: true }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("account-unavailable")).toHaveTextContent(
      "not_backed",
    );
  });
});

describe("phone navigation", () => {
  it("offers the bottom bar and opens the drawer from More and from the menu button", async () => {
    const user = userEvent.setup();
    renderShell(await fixtureData());
    const bar = screen.getByTestId("mobile-nav");
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Fleet", "Agent IAM", "Tools", "Spend"]);
    await user.click(within(bar).getByRole("button", { name: "More" }));
    const drawer = await screen.findByTestId("nav-drawer");
    await user.click(within(drawer).getByRole("link", { name: /Ontology/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("nav-drawer")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const again = await screen.findByTestId("nav-drawer");
    await user.click(within(again).getByTestId("assistant-launcher"));
    await waitFor(() => {
      expect(screen.queryByTestId("nav-drawer")).toBeNull();
    });
    expect(screen.getByTestId("assistant-flyout")).toHaveAttribute(
      "data-state",
      "open",
    );
  });

  it("falls back to organization pages when there is no workspace", () => {
    const onMore = vi.fn();
    render(
      <NextIntlClientProvider
        locale="en"
        messages={{ ...en, ...shellMessages }}
      >
        <MobileNav
          items={[
            { key: "billing", href: "/acme/billing", count: null, hot: false },
          ]}
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
  it("renders the shell for a context without workspaces", async () => {
    const data = await fixtureData();
    if (!data.context.ok) throw new Error("fixture context failed");
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
