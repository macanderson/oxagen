// The shell's reads through dataSource().shell (lane c1-promote): the viewer
// gate runs before the chrome reads anything, a not-backed read never shows
// "gap G0", and the engine-down words read red in the error ink, AA clean in
// light and dark.
import type { Page } from "@playwright/test";
import { expect, expectNoAxeViolations, setPageState, test } from "./support";

const FLEET = "/acme/core-platform";
const OVERLAY_AXE = { exclude: ["[data-base-ui-focus-guard]"] };

async function engineDown(page: Page, baseURL: string | undefined) {
  await page.context().addCookies([
    {
      name: "mc_shell_engine",
      value: "down",
      url: baseURL ?? "http://localhost:3000",
    },
  ]);
}

/** The computed text colour of an element, as the browser resolved it. */
const colorOf = (page: Page, testId: string, selector: string) =>
  page
    .getByTestId(testId)
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).color);

test.describe("shell · reads through the data source", () => {
  test("a stranger's organization is a 404 before the chrome reads anything", async ({
    signedInPage: page,
  }) => {
    await page.goto("/globex");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    await expect(page.getByTestId("assistant-launcher")).toHaveCount(0);
  });

  test("the notifications a page lists link to seeded runs", async ({
    signedInPage: page,
  }) => {
    await page.goto(FLEET);
    await page.getByTestId("notifications-trigger").click();
    const popover = page.getByTestId("notifications-popover");
    await expect(
      popover.getByRole("link", { name: "Open run_01K5RS7M2E8FJ3QW" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/run_01K5RS7M2E8FJ3QW");
    await expectNoAxeViolations(page, OVERLAY_AXE);
  });

  test("notifications not_backed says the store is not read yet, never gap G0", async ({
    signedInPage: page,
    baseURL,
  }) => {
    await page.context().addCookies([
      {
        name: "mc_shell_notifications",
        value: "not_backed",
        url: baseURL ?? "http://localhost:3000",
      },
    ]);
    await page.goto(FLEET);
    await page.getByTestId("notifications-trigger").click();
    const state = page.getByTestId("notifications-not_backed");
    await expect(state).toContainText("does not read it yet");
    await expect(state).not.toContainText("G0");
    await expectNoAxeViolations(page, OVERLAY_AXE);
  });

  test("shell:error keeps the page and names the notification store", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(
      context,
      baseURL ?? "http://localhost:3000",
      "error",
      "shell",
    );
    await page.goto(FLEET);
    await expect(
      page.getByRole("heading", { level: 1, name: "Fleet" }),
    ).toBeVisible();
    await expect(page.getByTestId("assistant-launcher")).toContainText(
      "engine down",
    );
    await expectNoAxeViolations(page);
  });
});

test.describe("shell · engine down reads red", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`${theme}: the launcher and flyout words take the error ink and stay AA`, async ({
      signedInPage: page,
      baseURL,
    }) => {
      await page.context().addCookies([
        {
          name: "theme",
          value: theme,
          url: baseURL ?? "http://localhost:3000",
        },
      ]);
      await page.goto(FLEET);
      const readyInk = await colorOf(
        page,
        "assistant-launcher",
        "span.font-mono",
      );

      await engineDown(page, baseURL);
      await page.goto(FLEET);
      await expect(page.getByTestId("assistant-launcher")).toContainText(
        "engine down",
      );
      const downInk = await colorOf(
        page,
        "assistant-launcher",
        "span.font-mono",
      );
      expect(downInk).not.toBe(readyInk);
      // Red dominates the resolved ink: the words are red, not the label grey.
      const [r = 0, g = 0, b = 0] = (downInk.match(/[\d.]+/g) ?? []).map(
        Number,
      );
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
      await expectNoAxeViolations(page);

      await page.getByTestId("assistant-launcher").click();
      await expect(page.getByTestId("assistant-engine-down")).toBeVisible();
      await expectNoAxeViolations(page, OVERLAY_AXE);
    });
  }
});
