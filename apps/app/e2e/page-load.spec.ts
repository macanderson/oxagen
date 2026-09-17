// The page-load oracle (ARCHITECTURE.md §6.3): every signed-in rev1 surface
// answers 200 and returns its own catalog title.
//
// The title is the assertion because it is the one signal that separates a page
// that rendered from a page that fell over. An error boundary, a not-found and a
// redirect to /login all answer 200 with a DIFFERENT title, so a row cannot pass
// by rendering the wrong thing. The console check is the second half: a page that
// renders its title while throwing in a client component is not a page that works.
import { expect, test } from "@playwright/test";
import { expectedTitle, SIGNED_IN_ROUTES } from "./routes";

for (const row of SIGNED_IN_ROUTES) {
  test(`${row.path} loads and titles itself ${row.titleKey}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(String(error)));

    const response = await page.goto(row.path, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status(), `${row.path} must answer 200`).toBe(200);

    // The signed-in surfaces must not bounce to the sign-in page: that would be
    // a 200 with the login title, which the title assertion below also catches,
    // but this names the failure.
    expect(new URL(page.url()).pathname, `${row.path} must not redirect`).toBe(
      row.path,
    );
    await expect(page).toHaveTitle(expectedTitle(row), { timeout: 15_000 });
    expect(errors, `${row.path} logged console errors`).toEqual([]);
  });
}
