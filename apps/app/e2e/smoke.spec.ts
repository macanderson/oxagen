import { expect, expectNoAxeViolations, test } from "./support";

test.describe("smoke", () => {
  test("login page renders and is axe clean", async ({ page }) => {
    const response = await page.goto("/login");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { level: 1, name: "Log in" }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Oxagen");
    await expectNoAxeViolations(page);
  });

  test("a workspace page without a session redirects to login", async ({
    page,
  }) => {
    await page.goto("/acme/core-platform");
    await expect(page).toHaveURL(/\/login\?next=%2Facme%2Fcore-platform$/);
  });

  test("the fixture session reaches a workspace page skeleton", async ({
    signedInPage: page,
  }) => {
    await page.goto("/acme/core-platform");
    await expect(
      page.getByRole("heading", { level: 1, name: "Fleet" }),
    ).toBeVisible();
    await expect(page.getByTestId("page-state-not_backed")).toContainText(
      "Not recorded yet",
    );
    await expectNoAxeViolations(page);
  });
});
