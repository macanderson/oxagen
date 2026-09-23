// The page-load oracle (ARCHITECTURE.md §6.3): every rev1 surface answers 200
// and returns its own catalog title — the signed-in ones on the storage state
// login.spec.ts saved, the anonymous ones in a fresh context.
//
// The title is the assertion because it is the one signal that separates a page
// that rendered from a page that fell over. An error boundary, a not-found and a
// redirect to /login all answer 200 with a DIFFERENT title, so a row cannot pass
// by rendering the wrong thing. The console check is the second half: a page that
// renders its title while throwing in a client component is not a page that works.
import { expect, type Page, test } from "@playwright/test";
import {
  ANONYMOUS_ROUTES,
  expectedTitle,
  type RouteRow,
  SIGNED_IN_ROUTES,
} from "./routes";

async function loadsAndTitlesItself(page: Page, row: RouteRow): Promise<void> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  const response = await page.goto(row.path, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${row.path} must answer 200`).toBe(200);

  // The surface must not bounce to the sign-in page: that would be a 200 with
  // the login title, which the title assertion below also catches, but this
  // names the failure.
  expect(new URL(page.url()).pathname, `${row.path} must not redirect`).toBe(
    row.path,
  );
  await expect(page).toHaveTitle(expectedTitle(row), { timeout: 15_000 });
  expect(errors, `${row.path} logged console errors`).toEqual([]);
}

for (const row of SIGNED_IN_ROUTES) {
  test(`${row.path} loads and titles itself ${row.titleKey}`, async ({
    page,
  }) => {
    await loadsAndTitlesItself(page, row);
    await expect(page.locator("main#main")).toBeVisible();
    const desktopPath = test.info().outputPath("desktop.png");
    await page.screenshot({
      path: desktopPath,
      fullPage: true,
      animations: "disabled",
    });
    await test
      .info()
      .attach("desktop", { path: desktopPath, contentType: "image/png" });
    await page.setViewportSize({ width: 390, height: 844 });
    const phonePath = test.info().outputPath("phone.png");
    await page.screenshot({
      path: phonePath,
      fullPage: true,
      animations: "disabled",
    });
    await test
      .info()
      .attach("phone", { path: phonePath, contentType: "image/png" });
    if (row.titleKey === "steering") {
      await page.locator('[data-tab="freshness"]').click();
      await expect(page.locator('[data-tab="freshness"]')).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page).toHaveURL(/\/steering\/freshness(?:\?|$)/);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.screenshot({
        path: test.info().outputPath("freshness-desktop.png"),
        fullPage: true,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: test.info().outputPath("freshness-phone.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
  });
}

// A fresh context, no saved storage state: these rows must render for a browser
// that holds no session at all, which is the browser the CLI sends to
// /cli/complete.
test.describe("anonymous", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const row of ANONYMOUS_ROUTES) {
    test(`${row.path} loads and titles itself ${row.titleKey} with no session`, async ({
      page,
    }) => {
      await loadsAndTitlesItself(page, row);
    });
  }
});
