// The onboarding reads through OnboardingReadPort (lane c1-promote): the
// mc_state switch walks the gate's and Register's states through the same reads
// production makes, not a screen-local cookie, and the not_backed state shows
// what the live source answers before G15 lands.
import { expect, expectNoAxeViolations, setPageState, test } from "./support";

const WRAP = "/welcome/wrap?org=acme&ws=core-platform";
const RUN = "/welcome/run?org=acme&ws=core-platform";
const REGISTER_WRAP =
  "/acme/core-platform/register/wrap?agent=perf-watch&harness=claude-code&tier=complex";

test.describe("onboarding · states through the read port", () => {
  test("not_backed · the wrap step names G15 instead of an installer", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(
      context,
      baseURL ?? "http://localhost:3000",
      "not_backed",
      "welcome",
    );
    await page.goto(WRAP);
    const notice = page.getByTestId("installer-not-backed");
    await expect(notice.getByTestId("page-state-not_backed")).toContainText(
      "milestone M1 (backend gap G15)",
    );
    await expectNoAxeViolations(page);
  });

  test("not_backed · the run step offers Fleet instead of waiting for a frame", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(
      context,
      baseURL ?? "http://localhost:3000",
      "not_backed",
      "welcome",
    );
    await page.goto(RUN);
    await expect(page.getByTestId("first-frame-not-backed")).toBeVisible();
    await expect(page.getByTestId("repo-not-backed")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("an unrecorded gate never keeps anyone out: step 1 renders under not_backed", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(
      context,
      baseURL ?? "http://localhost:3000",
      "not_backed",
      "welcome",
    );
    await page.goto("/welcome");
    await expect(
      page.getByRole("heading", { level: 1, name: "Name your organization" }),
    ).toBeVisible();
  });

  test("a state scoped to the gate leaves Register loaded", async ({
    signedInPage: page,
    context,
    baseURL,
  }) => {
    await setPageState(
      context,
      baseURL ?? "http://localhost:3000",
      "denied",
      "welcome",
    );
    await page.goto(REGISTER_WRAP);
    await expect(
      page.getByRole("heading", { level: 1, name: "Wrap the agent" }),
    ).toBeVisible();
    await expect(page.getByTestId("page-state-denied")).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  test("the scripted first frame names the agent being wrapped", async ({
    signedInPage: page,
  }) => {
    await page.goto(`${RUN}&harness=codex-cli`);
    await expect(page.getByText(/agent=acme\.core\.codex-cli/)).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe("invitations · read through the port", () => {
  test("the pending invitation names its inviter from the seed", async ({
    page,
  }) => {
    await page.goto("/invite/invi_acme_pending");
    await expect(page.getByText(/Priya Natarajan/)).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("an unknown token is not found (negative)", async ({ page }) => {
    await page.goto("/invite/invi_nope");
    await expect(page.getByTestId("page-state-not_backed")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
