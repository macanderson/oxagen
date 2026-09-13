// The onboarding gate (name → wrap → run) and Register an agent (name → wrap →
// first frame) on the fixture data source. Covers §19's states for the gate
// (loaded, waiting, unlocked, phone) and the register flow's denied, loading and
// error, navigation between steps, feedback 2's stable wrap card, and axe on
// every screen.
import type { Page } from "@playwright/test";
import { expect, expectNoAxeViolations, setPageState, test } from "./support";

const WRAP = "/welcome/wrap?org=acme&ws=core-platform";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("onboarding gate", () => {
  test("signed out · /welcome redirects to log in", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page).toHaveURL(/\/login\?next=%2Fwelcome$/);
  });

  test("step 1 · loaded, validates, and the address and namespace follow the name", async ({
    signedInPage: page,
  }) => {
    await page.goto("/welcome");
    await expect(
      page.getByRole("heading", { level: 1, name: "Name your organization" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Onboarding" })
        .locator('[aria-current="step"]'),
    ).toContainText("Name the organization");
    await expectNoAxeViolations(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Enter the organization's name."),
    ).toBeVisible();
    await expect(
      page.getByText("Enter a name for the first workspace."),
    ).toBeVisible();

    await page.getByLabel("Organization name").fill("Acme Robotics");
    await expect(page.getByLabel("Address", { exact: true })).toHaveValue(
      "acme-robotics",
    );
    await expect(page.getByLabel("Namespace")).toHaveValue("acme");
    await page.getByLabel("Namespace").fill("a");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Use 2–6 lowercase letters or digits."),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("/new-organization renders the same first step", async ({
    signedInPage: page,
  }) => {
    await page.goto("/new-organization");
    await expect(
      page.getByRole("heading", { level: 1, name: "Name your organization" }),
    ).toBeVisible();
  });

  test("walks name → wrap → run → unlocked, landing on Fleet", async ({
    signedInPage: page,
  }) => {
    await page.goto("/welcome");
    await page.getByLabel("Organization name").fill("Acme Robotics");
    await page.getByLabel("Address", { exact: true }).fill("acme");
    await page.getByLabel("Workspace name").fill("core-platform");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(/\/welcome\/wrap\?org=acme&ws=core-platform$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Wrap an agent" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: /Claude Code/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expectNoAxeViolations(page);

    await page.getByTestId("wrap-download").click();
    await expect(page).toHaveURL(
      /\/welcome\/run\?org=acme&ws=core-platform&harness=claude-code$/,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Start a run" }),
    ).toBeVisible();

    // waiting
    await expect(page.getByTestId("first-frame-waiting")).toBeVisible();
    await expectNoAxeViolations(page);

    // unlocked: the first frame arrives
    await expect(page.getByTestId("first-frame-connected")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("First frame received")).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByTestId("first-frame-open").click();
    await expect(page).toHaveURL(/\/acme\/core-platform$/);
  });

  test("run · binds the detected repository, or leaves the workspace provisional", async ({
    signedInPage: page,
  }) => {
    await page.goto(
      "/welcome/run?org=acme&ws=core-platform&harness=claude-code",
    );
    await expect(page.getByTestId("repo-detected")).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByTestId("repo-skipped")).toContainText("provisional");
    await page.getByRole("button", { name: "Bind acme/platform now" }).click();
    await expect(page.getByTestId("repo-bound")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("a finished step links back from the stepper", async ({
    signedInPage: page,
  }) => {
    await page.goto(WRAP);
    await page
      .getByRole("link", { name: "Done: Name the organization" })
      .click();
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("feedback 2 · the wrap card does not move when switching methods", async ({
    signedInPage: page,
  }) => {
    await page.goto(WRAP);
    const card = page.getByTestId("wrap-card");
    // The step streams in behind a Suspense boundary; boundingBox() does not wait.
    await expect(card).toBeVisible();
    const first = await card.boundingBox();
    expect(first).not.toBeNull();
    for (const name of [/Codex CLI/, /SDK agent/, /Claude Code/]) {
      await page.getByRole("tab", { name }).click();
      await expect(page.getByRole("tab", { name })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const box = await card.boundingBox();
      expect(box?.x).toBe(first?.x);
      expect(box?.width).toBe(first?.width);
    }
    await expectNoHorizontalScroll(page);
  });

  test("wrap · the SDK agent shows five lines with the agent key, per language", async ({
    signedInPage: page,
  }) => {
    await page.goto(WRAP);
    await page.getByRole("tab", { name: /SDK agent/ }).click();
    await expect(page.getByTestId("sdk-snippet")).toContainText(
      'key: "acme.core.claude-code"',
    );
    await page.getByRole("tab", { name: "Python" }).click();
    await expect(page.getByTestId("sdk-snippet")).toContainText(
      "oxagen.agent.wrap(",
    );
    await expectNoAxeViolations(page);
  });

  test("wrap · method tabs move with the arrow keys", async ({
    signedInPage: page,
  }) => {
    await page.goto(WRAP);
    await page.getByRole("tab", { name: /Claude Code/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /Codex CLI/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: /Codex CLI/ })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: /SDK agent/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("wrap · without an organization in the URL, asks to start from step 1", async ({
    signedInPage: page,
  }) => {
    await page.goto("/welcome/wrap");
    await expect(page.getByTestId("onboarding-scope-missing")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("wrap · a workspace the operator is not a member of reads as not found", async ({
    signedInPage: page,
  }) => {
    await page.goto("/welcome/wrap?org=acme&ws=finops");
    await expect(page.getByTestId("onboarding-scope-not-found")).toBeVisible();
    await expect(page.getByText("acme.finops", { exact: false })).toHaveCount(
      0,
    );
    await expectNoAxeViolations(page);
  });

  test("an unknown step is not found", async ({ signedInPage: page }) => {
    // The step is validated inside the streamed Suspense boundary, so assert the
    // not-found screen rather than the status line that was already sent.
    await page.goto("/welcome/billing");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  });

  test("denied", async ({ signedInPage: page, context, baseURL }) => {
    await setPageState(context, baseURL ?? "http://localhost:3000", "denied");
    await page.goto("/welcome");
    await expect(page.getByTestId("page-state-denied")).toContainText(
      "org.create",
    );
    await expectNoAxeViolations(page);
  });

  test("loading", async ({ signedInPage: page, context, baseURL }) => {
    await setPageState(context, baseURL ?? "http://localhost:3000", "loading");
    await page.goto("/welcome");
    await expect(page.getByTestId("page-state-loading")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("error · the collector cannot reach the proxy", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(context, baseURL ?? "http://localhost:3000", "error");
    await page.goto("/welcome/run?org=acme&ws=core-platform");
    await expect(page.getByTestId("first-frame-error")).toContainText(
      "The collector cannot reach the model proxy",
    );
    await expectNoAxeViolations(page);
  });

  for (const path of [
    "/welcome",
    WRAP,
    "/welcome/run?org=acme&ws=core-platform",
  ]) {
    test(`phone · ${path}`, async ({ signedInPage: page }) => {
      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoAxeViolations(page);
    });
  }
});

test.describe("register an agent", () => {
  const BASE = "/acme/core-platform/register";

  test("name → wrap → first frame → Fleet, reusing the gate's screens", async ({
    signedInPage: page,
  }) => {
    await page.goto(BASE);
    await expect(
      page.getByRole("heading", { level: 1, name: "Name the agent" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);

    await page.getByLabel("Slug").fill("Perf Watch!");
    await expect(
      page.getByText("The agent key becomes acme.core.perf-watch."),
    ).toBeVisible();
    await page.getByLabel("Harness").selectOption("codex-cli");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(
      /\/register\/wrap\?agent=perf-watch&harness=codex-cli&tier=complex$/,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Wrap the agent" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /Codex CLI/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expectNoAxeViolations(page);

    await page.getByTestId("wrap-continue").click();
    await expect(page).toHaveURL(
      /\/register\/run\?agent=perf-watch&tier=complex&harness=codex-cli$/,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Wait for the first frame" }),
    ).toBeVisible();
    await expect(page.getByTestId("first-frame-waiting")).toContainText(
      "acme.core.perf-watch",
    );
    await expect(page.getByTestId("first-frame-connected")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("link", { name: "Open in Fleet" }).click();
    await expect(page).toHaveURL(/\/acme\/core-platform$/);
  });

  test("validates the slug", async ({ signedInPage: page }) => {
    await page.goto(BASE);
    await page.getByLabel("Slug").fill("x");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByText("Use 2–40 lowercase letters, digits and hyphens."),
    ).toBeVisible();
  });

  test("cancel returns to Fleet", async ({ signedInPage: page }) => {
    await page.goto(BASE);
    await page.getByRole("link", { name: "Cancel" }).first().click();
    await expect(page).toHaveURL(/\/acme\/core-platform$/);
  });

  test("a later step without a named agent asks for step 1", async ({
    signedInPage: page,
  }) => {
    await page.goto(`${BASE}/wrap`);
    await expect(page.getByTestId("register-choice-missing")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("an unknown organization is not found", async ({
    signedInPage: page,
  }) => {
    await page.goto("/globex/labs/register");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
  });

  test("a workspace of the operator's organization they are not a member of is not found", async ({
    signedInPage: page,
  }) => {
    // Marcus is an Acme member but has no finops membership (src/server/fixture-tenancy.ts).
    await page.goto("/acme/finops/register");
    await expect(
      page.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toBeVisible();
    await expect(page.getByLabel("Slug")).toHaveCount(0);
  });

  test("denied", async ({ signedInPage: page, context, baseURL }) => {
    await setPageState(context, baseURL ?? "http://localhost:3000", "denied");
    await page.goto(BASE);
    await expect(page.getByTestId("page-state-denied")).toContainText(
      "agent.register on core-platform",
    );
    await expectNoAxeViolations(page);
  });

  test("phone", async ({ signedInPage: page }) => {
    await page.setViewportSize({ width: 400, height: 860 });
    await page.goto(
      `${BASE}/wrap?agent=perf-watch&harness=claude-code&tier=complex`,
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Wrap the agent" }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoAxeViolations(page);
  });
});
