// The page-load oracle (ARCHITECTURE.md §6.3): every rev1 surface answers 200
// and returns its own catalog title — the signed-in ones on the storage state
// login.spec.ts saved, the anonymous ones in a fresh context.
//
// The title is the assertion because it is the one signal that separates a page
// that rendered from a page that fell over. An error boundary, a not-found and a
// redirect to /login all answer 200 with a DIFFERENT title, so a row cannot pass
// by rendering the wrong thing. The console check is the second half: a page that
// renders its title while throwing in a client component is not a page that works.
// A page that only redirects is walked to the row it lands on and held to that
// row's path and title.
import { expect, type Page, test } from "@playwright/test";
import {
  ANONYMOUS_ROUTES,
  expectedTitle,
  REDIRECT_ROUTES,
  type RedirectRow,
  type RouteRow,
  SIGNED_IN_ROUTES,
  seededRoutes,
} from "./routes";
import { readSeedRecord } from "./support";

/** The console errors and uncaught exceptions the page reports from here on. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function loadsAndTitlesItself(page: Page, row: RouteRow): Promise<void> {
  const errors = collectErrors(page);

  const response = await page.goto(row.path, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${row.path} must answer 200`).toBe(200);

  // The surface must not bounce to the sign-in page: that would be a 200 with
  // the login title, which the title assertion below also catches, but this
  // names the failure. The query counts too: an Agents tab is `?tab=`, and a
  // redirect that dropped it would land on the Agents tab instead.
  const landed = new URL(page.url());
  expect(landed.pathname + landed.search, `${row.path} must not redirect`).toBe(
    row.path,
  );
  await expect(page).toHaveTitle(expectedTitle(row), { timeout: 15_000 });
  expect(errors, `${row.path} logged console errors`).toEqual([]);
}

/**
 * A redirect lands on its row: the server's redirect is followed by goto, and
 * one issued while the page streams is followed by the client, so the landing
 * is awaited rather than read once.
 */
async function movesOn(page: Page, row: RedirectRow): Promise<void> {
  const errors = collectErrors(page);

  const response = await page.goto(row.path, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${row.path} must answer 200`).toBe(200);
  await expect(page, `${row.path} must land on ${row.landsOn.path}`).toHaveURL(
    (url) => url.pathname + url.search === row.landsOn.path,
    { timeout: 15_000 },
  );
  await expect(page).toHaveTitle(expectedTitle(row.landsOn), {
    timeout: 15_000,
  });
  expect(errors, `${row.path} logged console errors`).toEqual([]);
}

const SIGNED_IN = [...SIGNED_IN_ROUTES, ...seededRoutes(readSeedRecord())];

for (const row of SIGNED_IN) {
  test(`${row.path} loads and titles itself ${expectedTitle(row)}`, async ({
    page,
  }) => {
    await loadsAndTitlesItself(page, row);
    // Under the organization shell, the frame's main#main is in the document
    // from the first byte, and a page streaming into a hidden node beside its
    // skeleton brings no second one (ADR-227, #4053). One target holds at any
    // moment, so this count does not retry: a second main fails it at once.
    if ((await page.getByTestId("shell").count()) > 0) {
      expect(
        await page.locator("main#main").count(),
        `${row.path} must hold one main#main while it streams`,
      ).toBe(1);
    }
    // The onboarding gate's step owns its main, so wait for the settled step.
    await expect(page.locator("main#main")).toHaveCount(1, { timeout: 15_000 });
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
    if (row.path.endsWith("/steering")) {
      // The tabs are path segments: Gates carries the freshness gates the
      // one-route page called Settings (roadmap pages/steering.md).
      // Cache Components keeps the previous route's tab bar mounted but
      // hidden after navigation, so only the visible bar is asserted.
      await page.locator('[data-tab="gates"]:visible').click();
      await expect(page).toHaveURL(/\/steering\/gates(?:\?|$)/);
      await expect(page.locator('[data-tab="gates"]:visible')).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.screenshot({
        path: test.info().outputPath("gates-desktop.png"),
        fullPage: true,
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: test.info().outputPath("gates-phone.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
  });
}

for (const row of REDIRECT_ROUTES) {
  test(`${row.path} moves on to ${row.landsOn.path}`, async ({ page }) => {
    await movesOn(page, row);
  });
}

// A fresh context, no saved storage state: these rows must render for a browser
// that holds no session at all, which is the browser the CLI sends to
// /cli/complete.
test.describe("anonymous", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const row of ANONYMOUS_ROUTES) {
    test(`${row.path} loads and titles itself ${expectedTitle(row)} with no session`, async ({
      page,
    }) => {
      await loadsAndTitlesItself(page, row);
    });
  }
});
