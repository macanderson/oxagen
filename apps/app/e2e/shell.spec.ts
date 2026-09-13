// The organization and workspace shell on fixtures (lane L3): the chrome
// renders, every nav link reaches its page, the command menu opens and
// navigates, notifications open, the Account dialog opens, the theme switches,
// unknown organizations and workspaces are 404s, and every state is axe clean.
import type { Page } from "@playwright/test";
import { expect, expectNoAxeViolations, test } from "./support";

const ORG = "acme";
const WS = "core-platform";

/**
 * Base UI's focus guards are visually hidden, aria-hidden spans that keep focus
 * inside an open overlay; they are the library's mechanism, not page content.
 */
const OVERLAY_AXE = { exclude: ["[data-base-ui-focus-guard]"] };

const sidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Sidebar" });
const mainNav = (page: Page) =>
  sidebar(page).getByRole("navigation", { name: "Main" });

/** Every page the sidebar reaches, with the heading the page renders. */
const SIDEBAR_PAGES = [
  { label: "Fleet", path: `/${ORG}/${WS}`, heading: "Fleet" },
  { label: "Agent IAM", path: `/${ORG}/${WS}/agents`, heading: "Agents" },
  { label: "Tools", path: `/${ORG}/${WS}/tools`, heading: "Tools" },
  { label: "Ontology", path: `/${ORG}/${WS}/ontology`, heading: "Ontology" },
  { label: "Steering", path: `/${ORG}/${WS}/steering`, heading: "Steering" },
  { label: "Spend", path: `/${ORG}/${WS}/spend`, heading: "Spend" },
  { label: "Organization", path: `/${ORG}`, heading: "Organization" },
  { label: "Billing", path: `/${ORG}/billing`, heading: "Billing" },
  { label: "Audit", path: `/${ORG}/audit`, heading: "Audit" },
] as const;

test.describe("shell · loaded", () => {
  test("renders the sidebar, top bar and page, and is axe clean", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}/${WS}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Fleet" }),
    ).toBeVisible();
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole("banner", { name: "Top bar" })).toBeVisible();
    await expect(
      sidebar(page).getByRole("button", {
        name: "Switch organization, current Acme Robotics",
      }),
    ).toBeVisible();
    await expect(
      sidebar(page).getByRole("button", {
        name: "Switch workspace, current Core platform",
      }),
    ).toBeVisible();
    await expect(
      mainNav(page).getByRole("link", { name: /^Fleet/ }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      mainNav(page).getByRole("link", { name: /^Agent IAM/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Breadcrumb" }),
    ).toContainText("Acme Robotics");
    await expect(page.getByTestId("mobile-nav")).toBeHidden();
    await expectNoAxeViolations(page);
  });

  for (const target of SIDEBAR_PAGES) {
    test(`sidebar link ${target.label} → ${target.path}`, async ({
      signedInPage: page,
    }) => {
      await page.goto(`/${ORG}/${WS}/steering`);
      await mainNav(page)
        .getByRole("link", { name: new RegExp(`^${target.label}`) })
        .click();
      await expect(page).toHaveURL(new RegExp(`${target.path}$`));
      await expect(
        page.getByRole("heading", { level: 1, name: target.heading }),
      ).toBeVisible();
      await expect(
        mainNav(page).getByRole("link", {
          name: new RegExp(`^${target.label}`),
        }),
      ).toHaveAttribute("aria-current", "page");
    });
  }

  test("every page route renders inside the shell and is axe clean", async ({
    signedInPage: page,
  }) => {
    const routes = [
      ...SIDEBAR_PAGES.map((p) => p.path),
      `/${ORG}/api-keys`,
      `/${ORG}/roles`,
      `/${ORG}/${WS}/runs/run_01K5RS7M2E8FJ3QW`,
      `/${ORG}/${WS}/agents/acme.core.release-manager`,
      `/${ORG}/${WS}/agents/acme.core.release-manager/source`,
      `/${ORG}/${WS}/agents/acme.core.release-manager/mandates/mnd_4471`,
      `/${ORG}/${WS}/register`,
      `/${ORG}/finops`,
    ];
    for (const route of routes) {
      await page.goto(route);
      await expect(page.getByTestId("shell"), route).toBeVisible();
      await expect(sidebar(page), route).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 1 }),
        route,
      ).toBeVisible();
      await expectNoAxeViolations(page);
    }
  });

  test("breadcrumbs follow the page", async ({ signedInPage: page }) => {
    await page.goto(`/${ORG}/${WS}/runs/run_01K5RS7M2E8FJ3QW`);
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(
      crumbs.getByRole("link", { name: "Acme Robotics" }),
    ).toHaveAttribute("href", `/${ORG}`);
    await expect(
      crumbs.getByRole("link", { name: "Core platform" }),
    ).toHaveAttribute("href", `/${ORG}/${WS}`);
    await crumbs.getByRole("link", { name: "Fleet" }).click();
    await expect(page).toHaveURL(new RegExp(`/${ORG}/${WS}$`));
  });

  test("the workspace switcher moves to another workspace", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}/${WS}`);
    await sidebar(page)
      .getByRole("button", { name: /Switch workspace/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "Switch workspace" });
    await expect(dialog).toBeVisible();
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await dialog.getByRole("link", { name: /FinOps/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${ORG}/finops$`));
    await expect(
      sidebar(page).getByRole("button", {
        name: "Switch workspace, current FinOps",
      }),
    ).toBeVisible();
  });
});

test.describe("shell · command menu", () => {
  test("opens with the keyboard shortcut, filters and navigates", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}/${WS}`);
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    const menu = page.getByTestId("command-menu");
    await expect(menu).toBeVisible();
    const input = menu.getByRole("combobox");
    await expect(input).toBeFocused();
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await input.fill("billing");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${ORG}/billing$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Billing" }),
    ).toBeVisible();
    await expect(menu).toBeHidden();
  });

  test("opens from the search button, lists runs and actions, and Escape closes it", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}`);
    await page.getByRole("button", { name: "Search or run an action" }).click();
    const menu = page.getByTestId("command-menu");
    await expect(
      menu.getByRole("group", { name: "Runs", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("option", { name: /Register an agent/ }),
    ).toBeVisible();
    await menu.getByRole("option", { name: /run_01K5RS7M2E8FJ3QW/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${ORG}/${WS}/runs/run_01K5RS7M2E8FJ3QW$`),
    );
    await page.keyboard.press("ControlOrMeta+k");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("reaches the API keys and roles pages", async ({
    signedInPage: page,
  }) => {
    for (const [query, path, heading] of [
      ["API keys", `/${ORG}/api-keys`, "API keys"],
      ["Roles", `/${ORG}/roles`, "Roles"],
    ] as const) {
      await page.goto(`/${ORG}/${WS}`);
      await page
        .getByRole("button", { name: "Search or run an action" })
        .click();
      await page.getByTestId("command-menu").getByRole("combobox").fill(query);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
    }
  });
});

test.describe("shell · notifications", () => {
  test("open from the bell with the unread count", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}/${WS}`);
    const bell = page.getByRole("button", { name: "Notifications, 3 unread" });
    await bell.click();
    const popover = page.getByTestId("notifications-popover");
    await expect(popover).toBeVisible();
    await expect(
      popover.getByTestId("notifications-list").getByRole("listitem"),
    ).toHaveCount(8);
    await expect(popover).toContainText("Approval waiting");
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
  });

  for (const [state, testId] of [
    ["empty", "notifications-empty"],
    ["error", "notifications-error"],
    ["not_backed", "notifications-not_backed"],
  ] as const) {
    test(`notifications · ${state}`, async ({
      signedInPage: page,
      context,
      baseURL,
    }) => {
      await context.addCookies([
        {
          name: "mc_shell_notifications",
          value: state,
          url: baseURL ?? "http://localhost:3000",
        },
      ]);
      await page.goto(`/${ORG}/${WS}`);
      await page.getByTestId("notifications-trigger").click();
      await expect(page.getByTestId(testId)).toBeVisible();
      await expectNoAxeViolations(page, OVERLAY_AXE);
    });
  }
});

test.describe("shell · account", () => {
  test("the Account dialog opens from the user menu on each tab", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}/${WS}`);
    await page
      .getByRole("button", { name: "Account menu for Marcus Bell" })
      .click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    const dialog = page.getByTestId("account-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog.getByTestId("account-panel-profile")).toContainText(
      "Marcus Bell",
    );
    await expectNoAxeViolations(page, OVERLAY_AXE);
    for (const tab of ["Preferences", "Security", "Privacy"] as const) {
      await dialog.getByRole("tab", { name: tab }).click();
      await expect(
        dialog.getByTestId(`account-panel-${tab.toLowerCase()}`),
      ).toBeVisible();
      await expectNoAxeViolations(page, OVERLAY_AXE);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("?dialog=account&tab=security opens the dialog on that tab", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}?dialog=account&tab=security`);
    const dialog = page.getByTestId("account-dialog");
    await expect(dialog.getByRole("tab", { name: "Security" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(dialog).toContainText("this device");
  });

  test("theme: light, dark and system through data-theme, remembered across reloads", async ({
    signedInPage: page,
  }) => {
    await page.goto(`/${ORG}/${WS}?dialog=account&tab=preferences`);
    const select = page.getByTestId("theme-select");
    const html = page.locator("html");
    await select.selectOption("dark");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveClass(/\bdark\b/);
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await page.getByTestId("theme-select").selectOption("light");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await page.getByTestId("theme-select").selectOption("system");
    await expect(html).not.toHaveAttribute("data-theme", /.+/);
  });
});

test.describe("shell · not found", () => {
  test("an organization the viewer does not belong to is a 404, never a hint", async ({
    signedInPage: page,
  }) => {
    await page.goto("/globex");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Sidebar" }),
    ).toBeHidden();
  });

  test("an unknown workspace is a 404", async ({ signedInPage: page }) => {
    await page.goto(`/${ORG}/no-such-workspace`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  });
});
