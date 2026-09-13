// The sign-in flows on the fixture data source (MC_DATA=fixture): every page
// renders, validates and is axe clean; log in keeps a same-origin ?next= and
// refuses any other; the session gate sends a signed-out visit to /login.
//
// Fixture values mirror src/features/auth/fixture.ts (not imported: that module
// resolves the app's "@/" alias, which the Playwright loader does not).
import type { Page } from "@playwright/test";
import { FIXTURE_USER, expect, expectNoAxeViolations, test } from "./support";

const PASSWORD = "mission-control";
const TOTP = "602914";
const RESET_TOKEN = "rst_fixture_01";

async function logIn(
  page: Page,
  email: string = FIXTURE_USER.email,
  password: string = PASSWORD,
) {
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("auth pages render and are axe clean", () => {
  const pages: Array<[string, string]> = [
    ["/login", "Log in"],
    ["/signup", "Govern the agents you already run."],
    ["/verify?email=marcus.bell%40acme.example", "Check your email"],
    ["/two-factor", "Two-factor authentication"],
    ["/forgot-password", "Reset your password"],
    [`/reset-password?token=${RESET_TOKEN}`, "Set a new password"],
    ["/invite/invi_acme_pending", "Join Acme Robotics on Oxagen"],
  ];
  for (const [path, heading] of pages) {
    test(`${path} · loaded`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test(`${path} · phone`, async ({ page }) => {
      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoAxeViolations(page);
    });
  }
});

test.describe("log in", () => {
  test("validates empty fields in place", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByText("Enter your work email.")).toBeVisible();
    await expect(page.getByText("Enter your password.")).toBeVisible();
    await expect(page.getByLabel("Work email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expectNoAxeViolations(page);
  });

  test("error · wrong password is announced and nothing navigates", async ({
    page,
  }) => {
    await page.goto("/login");
    await logIn(page, FIXTURE_USER.email, "not-the-password");
    await expect(page.getByTestId("login-outcome")).toContainText(
      "Email or password is wrong",
    );
    await expect(page).toHaveURL(/\/login$/);
    await expectNoAxeViolations(page);
  });

  test("an unauthenticated visit to a workspace redirects to /login with next", async ({
    page,
  }) => {
    await page.goto("/acme/core-platform");
    await expect(page).toHaveURL(/\/login\?next=%2Facme%2Fcore-platform$/);
  });

  test("signing in returns to the page in ?next", async ({ page }) => {
    await page.goto("/acme/core-platform");
    await expect(page).toHaveURL(/\/login\?next=/);
    await logIn(page);
    await expect(page).toHaveURL(/\/acme\/core-platform$/);
  });

  for (const hostile of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
  ]) {
    test(`?next=${hostile} lands in-app, never on another host`, async ({
      page,
      baseURL,
    }) => {
      await page.goto(`/login?next=${encodeURIComponent(hostile)}`);
      await logIn(page);
      await page.waitForURL((url) => !url.pathname.startsWith("/login"));
      const landed = new URL(page.url());
      expect(landed.origin).toBe(
        new URL(baseURL ?? "http://localhost:3000").origin,
      );
      expect(landed.pathname).toBe("/");
    });
  }

  test("links carry ?next to sign up", async ({ page }) => {
    await page.goto("/login?next=%2Facme%2Fcore-platform");
    await expect(
      page.getByRole("link", { name: "Create an account" }),
    ).toHaveAttribute("href", "/signup?next=%2Facme%2Fcore-platform");
  });
});

test.describe("sign up", () => {
  test("validates name, email and password length", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Work email").fill("not-an-email");
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Enter your name.")).toBeVisible();
    await expect(
      page.getByText("Enter an email address like name@company.com."),
    ).toBeVisible();
    await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("a new account enters the onboarding gate", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Name").fill("Marcus Bell");
    await page.getByLabel("Work email").fill(FIXTURE_USER.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    // The first visit compiles /welcome under `next dev`, which can outlast the
    // default 10s assertion window on a cold server.
    await expect(page).toHaveURL(/\/welcome$/, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: "Name your organization" }),
    ).toBeVisible();
  });

  test("the password can be shown and hidden", async ({ page }) => {
    await page.goto("/signup");
    const password = page.getByLabel("Password", { exact: true });
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(password).toHaveAttribute("type", "text");
  });
});

test.describe("two-factor", () => {
  test("validates the six digits", async ({ page }) => {
    await page.goto("/two-factor");
    await page.getByLabel("Authentication code").fill("12345");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(
      page.getByText("Enter the six digits from your authenticator app."),
    ).toBeVisible();
  });

  test("error · a wrong code is announced", async ({ page }) => {
    await page.goto("/two-factor");
    await page.getByLabel("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByTestId("two-factor-outcome")).toContainText(
      "That code is wrong",
    );
    await expectNoAxeViolations(page);
  });

  test("switches to a recovery code", async ({ page }) => {
    await page.goto("/two-factor");
    await page
      .getByRole("button", { name: "Use a recovery code instead" })
      .click();
    await expect(page.getByLabel("Recovery code")).toBeVisible();
  });

  test("a good code completes sign-in at ?next", async ({ page }) => {
    await page.goto("/two-factor?next=%2Facme%2Fcore-platform");
    await page.getByLabel("Authentication code").fill(TOTP);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/acme\/core-platform$/);
  });
});

test.describe("password reset", () => {
  test("forgot · validates, then answers without saying whether the account exists", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Work email").fill("nope");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(
      page.getByText("Enter an email address like name@company.com."),
    ).toBeVisible();
    await page.getByLabel("Work email").fill("anyone@acme.example");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByTestId("forgot-sent")).toContainText(
      "If an account exists for anyone@acme.example",
    );
    await expectNoAxeViolations(page);
  });

  test("reset · the two passwords must match", async ({ page }) => {
    await page.goto(`/reset-password?token=${RESET_TOKEN}`);
    await page
      .getByLabel("New password", { exact: true })
      .fill("Rq7!mesa-lattice");
    await page.getByLabel("Confirm new password").fill("Rq7!mesa-latice");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(
      page.getByText("The two passwords do not match."),
    ).toBeVisible();
  });

  test("reset · a good token sets the password", async ({ page }) => {
    await page.goto(`/reset-password?token=${RESET_TOKEN}`);
    await page
      .getByLabel("New password", { exact: true })
      .fill("Rq7!mesa-lattice");
    await page.getByLabel("Confirm new password").fill("Rq7!mesa-lattice");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByTestId("reset-done")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("reset · error · an expired or missing link offers a new one", async ({
    page,
  }) => {
    await page.goto("/reset-password?token=rst_spent");
    await page
      .getByLabel("New password", { exact: true })
      .fill("Rq7!mesa-lattice");
    await page.getByLabel("Confirm new password").fill("Rq7!mesa-lattice");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByTestId("reset-expired")).toBeVisible();
    await page.goto("/reset-password");
    await expect(
      page.getByRole("link", { name: "Request a new link" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("verify email", () => {
  test("validates the resend address and confirms neutrally", async ({
    page,
  }) => {
    await page.goto("/verify");
    await page.getByRole("button", { name: "Send a new link" }).click();
    await expect(page.getByText("Enter your work email.")).toBeVisible();
    await page.getByLabel("Work email").fill("marcus.bell@acme.example");
    await page.getByRole("button", { name: "Send a new link" }).click();
    await expect(page.getByTestId("verify-resent")).toBeVisible();
  });

  test("error · a spent link says so", async ({ page }) => {
    await page.goto("/verify?error=INVALID_TOKEN");
    await expect(page.getByTestId("verify-expired")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("accept an invitation", () => {
  test("signed out · asks to log in as the invited address, carrying the invitation", async ({
    page,
  }) => {
    await page.goto("/invite/invi_acme_pending");
    await expect(
      page.getByRole("link", { name: "Log in to accept" }),
    ).toHaveAttribute("href", "/login?next=%2Finvite%2Finvi_acme_pending");
  });

  test("signed in as the invitee · accept lands in the organization", async ({
    signedInPage: page,
  }) => {
    await page.goto("/invite/invi_acme_pending");
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page).toHaveURL(/\/acme$/);
  });

  test("denied · an invitation for another account", async ({
    signedInPage: page,
  }) => {
    await page.goto("/invite/invi_acme_other");
    await expect(page.getByTestId("invite-wrong-account")).toContainText(
      "dana.okafor@acme.example",
    );
    await expectNoAxeViolations(page);
  });

  test("error · an accepted invitation is closed", async ({
    signedInPage: page,
  }) => {
    await page.goto("/invite/invi_acme_accepted");
    await expect(page.getByTestId("invite-closed-accepted")).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("error · an unknown token", async ({ page }) => {
    await page.goto("/invite/invi_missing");
    await expect(page.getByTestId("invite-not-found")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("callbacks", () => {
  test("cli/authorize · error · bad parameters render inline, never redirect", async ({
    page,
  }) => {
    await page.goto(
      "/cli/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=s",
    );
    await expect(page.getByTestId("cli-invalid")).toContainText(
      "redirect_uri must be an HTTP loopback address",
    );
    await expect(page).toHaveURL(/\/cli\/authorize/);
    await expectNoAxeViolations(page);
  });

  test("cli/authorize · signed out · a valid request goes to log in and comes back", async ({
    page,
  }) => {
    const query = new URLSearchParams({
      redirect_uri: "http://127.0.0.1:53682/callback",
      state: "st_1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    });
    await page.goto(`/cli/authorize?${query.toString()}`);
    await expect(page).toHaveURL(/\/login\?next=%2Fcli%2Fauthorize%3F/);
    await logIn(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "Authorize the Oxagen CLI" }),
    ).toBeVisible();
    await expect(page.getByLabel("Organization")).toHaveValue("acme");
    await expectNoAxeViolations(page);
  });

  test("github/setup · signed in · lands on the workspace's repositories", async ({
    signedInPage: page,
  }) => {
    const response = await page.request.get(
      "/github/setup?installation_id=12345&setup_action=update",
      {
        maxRedirects: 0,
      },
    );
    expect(response.status()).toBe(307);
    expect(response.headers().location).toContain(
      "/acme/core-platform/ontology/repositories?github_installed=1",
    );
  });

  test("api/auth · fixture mode has no Better Auth behind it", async ({
    page,
  }) => {
    const response = await page.request.post("/api/auth/sign-in/email", {
      data: {},
    });
    expect(response.status()).toBe(404);
  });
});
