// The shell at phone width (spec §19 "phone" for the shell's panels; feedback 3:
// <MobileNav> is the seam, a plain bottom bar until the design lands).
import { expect, expectNoAxeViolations, test } from "./support";

const OVERLAY_AXE = { exclude: ["[data-base-ui-focus-guard]"] };

test.use({ viewport: { width: 400, height: 860 } });

test.describe("shell · phone", () => {
  test("shows <MobileNav> instead of the sidebar, and is axe clean", async ({
    signedInPage: page,
  }) => {
    await page.goto("/acme/core-platform");
    await expect(
      page.getByRole("heading", { level: 1, name: "Fleet" }),
    ).toBeVisible();
    const bar = page.getByRole("navigation", { name: "Mobile" });
    await expect(bar).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Sidebar" }),
    ).toBeHidden();
    await expect(bar.getByRole("link")).toHaveText([
      "Fleet",
      "Agent IAM",
      "Tools",
      "Spend",
    ]);
    await expect(bar.getByRole("link", { name: "Fleet" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The page is not hidden behind the bar.
    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(
      (barBox?.y ?? 0) + (barBox?.height ?? Number.POSITIVE_INFINITY),
    ).toBeLessThanOrEqual(860);
    await expectNoAxeViolations(page);
  });

  test("the bottom bar navigates", async ({ signedInPage: page }) => {
    await page.goto("/acme/core-platform");
    const bar = page.getByRole("navigation", { name: "Mobile" });
    await bar.getByRole("link", { name: "Spend" }).click();
    await expect(page).toHaveURL(/\/acme\/core-platform\/spend$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Spend" }),
    ).toBeVisible();
    await expect(bar.getByRole("link", { name: "Spend" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("More opens the full navigation drawer, which navigates and closes", async ({
    signedInPage: page,
  }) => {
    await page.goto("/acme/core-platform");
    await page
      .getByRole("navigation", { name: "Mobile" })
      .getByRole("button", { name: "More" })
      .click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await drawer.getByRole("link", { name: /^Audit/ }).click();
    await expect(page).toHaveURL(/\/acme\/audit$/);
    await expect(drawer).toBeHidden();
  });

  test("the top bar menu button opens the drawer too", async ({
    signedInPage: page,
  }) => {
    await page.goto("/acme");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByTestId("nav-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-drawer")).toBeHidden();
  });

  test("notifications, command menu and Account dialog fit a phone and are axe clean", async ({
    signedInPage: page,
  }) => {
    await page.goto("/acme/core-platform");
    await page.getByTestId("notifications-trigger").click();
    const popover = page.getByTestId("notifications-popover");
    await expect(popover).toBeVisible();
    expect((await popover.boundingBox())?.width).toBeLessThanOrEqual(400);
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Search or run an action" }).click();
    await expect(page.getByTestId("command-menu")).toBeVisible();
    await expectNoAxeViolations(page, OVERLAY_AXE);
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "Account menu for Marcus Bell" })
      .click();
    await page.getByRole("menuitem", { name: "Privacy and data" }).click();
    const dialog = page.getByTestId("account-dialog");
    await expect(dialog.getByRole("tab", { name: "Privacy" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect((await dialog.boundingBox())?.width).toBeLessThanOrEqual(400);
    await expectNoAxeViolations(page, OVERLAY_AXE);
  });
});
