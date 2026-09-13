// The assistant flyout (spec §19 "Assistant panel": collapsed, open, engine
// down, phone; plan W9: the down state is read from the port).
import type { Page } from "@playwright/test";
import { expect, expectNoAxeViolations, test } from "./support";

const OVERLAY_AXE = { exclude: ["[data-base-ui-focus-guard]"] };
const FLEET = "/acme/core-platform";

/** Wait for the flyout's translate/opacity transition to finish before measuring colours. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByTestId("assistant-flyout")
        .evaluate((el) => el.getAnimations().length),
    )
    .toBe(0);
}

test.describe("assistant flyout", () => {
  test("collapsed: the host is mounted but inert and out of view", async ({
    signedInPage: page,
  }) => {
    await page.goto(FLEET);
    const flyout = page.getByTestId("assistant-flyout");
    await expect(flyout).toHaveAttribute("data-state", "closed");
    await expect(flyout).toHaveAttribute("inert", "");
    await expect(flyout).toBeHidden();
    await expect(page.getByTestId("assistant-launcher")).toContainText(
      "glm-flash · ready",
    );
    await expectNoAxeViolations(page);
  });

  test("open: flies out from the sidebar launcher and closes with Escape", async ({
    signedInPage: page,
  }) => {
    await page.goto(FLEET);
    const launcher = page.getByTestId("assistant-launcher");
    await launcher.click();
    const flyout = page.getByRole("complementary", { name: "Assistant" });
    await expect(flyout).toBeVisible();
    await expect(launcher).toHaveAttribute("aria-expanded", "true");
    await expect(flyout.getByTestId("assistant-ready")).toBeVisible();
    // It flies out beside the rail, over the page, without moving the page.
    // The box is read once the 300ms fly-out has landed.
    const rail = await page
      .getByRole("complementary", { name: "Sidebar" })
      .boundingBox();
    expect(rail).not.toBeNull();
    const railEdge = Math.round((rail?.x ?? 0) + (rail?.width ?? 0)) - 1;
    await expect
      .poll(async () => Math.round((await flyout.boundingBox())?.x ?? -1))
      .toBeGreaterThanOrEqual(railEdge);
    await settled(page);
    await expect(
      flyout.getByRole("button", { name: "Close the assistant" }),
    ).toBeFocused();
    await expectNoAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("assistant-flyout")).toHaveAttribute(
      "data-state",
      "closed",
    );
  });

  test("the top bar button toggles it too", async ({ signedInPage: page }) => {
    await page.goto("/acme/billing");
    const toggle = page
      .getByRole("banner")
      .getByRole("button", { name: "Assistant" });
    await toggle.click();
    await expect(
      page.getByRole("complementary", { name: "Assistant" }),
    ).toBeVisible();
    await toggle.click();
    await expect(page.getByTestId("assistant-flyout")).toHaveAttribute(
      "data-state",
      "closed",
    );
  });

  test("engine down: named by the port, composer disabled, retry re-reads", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      {
        name: "mc_shell_engine",
        value: "down",
        url: baseURL ?? "http://localhost:3000",
      },
    ]);
    await page.goto(FLEET);
    await expect(page.getByTestId("assistant-launcher")).toContainText(
      "engine down",
    );
    await page.getByTestId("assistant-launcher").click();
    const down = page.getByTestId("assistant-engine-down");
    await expect(down).toBeVisible();
    await settled(page);
    await expect(down).toContainText("The Stella engine is not answering");
    await expect(down).toContainText("stella serve returned 503");
    await expect(
      page.getByRole("textbox", { name: "Message the assistant" }),
    ).toBeDisabled();
    await expectNoAxeViolations(page);

    // The engine comes back: Retry re-reads health from the port.
    await context.addCookies([
      {
        name: "mc_shell_engine",
        value: "up",
        url: baseURL ?? "http://localhost:3000",
      },
    ]);
    await down.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("assistant-ready")).toBeVisible();
    await expect(page.getByTestId("assistant-launcher")).toContainText(
      "glm-flash · ready",
    );
  });

  test("phone: the flyout covers the column and is axe clean", async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 400, height: 860 });
    await page.goto(FLEET);
    await page
      .getByRole("banner")
      .getByRole("button", { name: "Assistant" })
      .click();
    const flyout = page.getByRole("complementary", { name: "Assistant" });
    await expect(flyout).toBeVisible();
    await settled(page);
    const box = await flyout.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(399);
    await expectNoAxeViolations(page, OVERLAY_AXE);
  });
});
