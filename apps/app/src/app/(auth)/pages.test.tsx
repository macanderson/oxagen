// @vitest-environment jsdom
// Each sign-in page names itself once: generateMetadata returns its pages.* title
// and the page's one h1 reads the same string (ARCHITECTURE.md §1.2). The forms
// are islands with their own tests; here they render as stand-ins.
import type { ReactNode } from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";
import {
  expectPageTitle,
  type PageModule,
  renderPage,
  routeProps,
} from "@/test/render-page";

const { includesAllowance } = vi.hoisted(() => ({
  includesAllowance: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<typeof import("@/features/auth/routes")>(
    "@/features/auth/routes",
  )),
  ...(await vi.importActual<typeof import("@/features/auth/query-email")>(
    "@/features/auth/query-email",
  )),
  // Forms whose full-card states replace the header render it themselves;
  // the stand-ins render the header they are handed.
  ForgotPasswordForm: ({ header }: { header: ReactNode }) => header,
  InviteHint: () => null,
  AuthTags: ({ tags }: { tags: readonly string[] }) => (
    <ul data-testid="auth-tags">
      {tags.map((tag) => (
        <li key={tag}>{tag}</li>
      ))}
    </ul>
  ),
  signupIncludesAllowance: () => includesAllowance(),
  LoginForm: ({ header }: { header: ReactNode }) => header,
  oauthQueryOutcome: () => null,
  // The stand-ins below also show what the page read from its query.
  ResetPasswordForm: ({
    header,
    token,
  }: {
    header: ReactNode;
    token: string;
  }) => (
    <>
      {header}
      <p data-testid="reset-token" data-token={token} />
    </>
  ),
  SignupForm: ({ email }: { email: string | null }) => (
    <form data-testid="signup-form" data-email={email ?? "none"} />
  ),
  TwoFactorForm: ({ title }: { title: string }) => <h1>{title}</h1>,
  VerifyPanel: ({
    email,
    expired,
  }: {
    email: string | null;
    expired: boolean;
  }) => (
    <p
      data-testid="verify-panel"
      data-email={email ?? "none"}
      data-expired={String(expired)}
    />
  ),
}));

type Load = () => Promise<PageModule<object>>;

const PAGES: [string, Load, Record<string, string>][] = [
  ["login", () => import("./login/page"), {}],
  ["verify", () => import("./verify/page"), { email: "marcus@a-intel.com" }],
  ["twoFactor", () => import("./two-factor/page"), {}],
  ["forgotPassword", () => import("./forgot-password/page"), {}],
  ["resetPassword", () => import("./reset-password/page"), { token: "t" }],
];

describe("sign-in pages", () => {
  it.each(PAGES)(
    "pages.%s is the document title and the one h1",
    async (key, load, query) => {
      await expectPageTitle(
        await load(),
        routeProps({}, query),
        translator("pages")(key),
      );
    },
  );
});

describe("sign-up title", () => {
  it("names the page by its eyebrow, because its one h1 is the tagline (ARCHITECTURE.md §1.2)", async () => {
    await expectPageTitle(
      await import("./signup/page"),
      routeProps({}, {}),
      translator("auth")("signup.eyebrow"),
      translator("pages")("signup"),
    );
    expect(translator("auth")("signup.eyebrow")).toBe("Create your account");
  });
});

/** Renders a page's default export at `query` into the document. */
async function renderAt(load: Load, query: Record<string, string>) {
  const page = await load();
  await renderPage(await page.default(routeProps({}, query)));
}

const auth = translator("auth");

describe("reset-password query", () => {
  const load: Load = () => import("./reset-password/page");
  const token = () => screen.getByTestId("reset-token").dataset.token;

  it("hands the form the token from a good link", async () => {
    await renderAt(load, { token: "rst_1" });
    expect(token()).toBe("rst_1");
  });

  it("a spent link (?error=) hands the form no token, even beside one (negative)", async () => {
    await renderAt(load, { token: "rst_1", error: "INVALID_TOKEN" });
    expect(token()).toBe("");
  });

  it("a link without a token hands the form none", async () => {
    await renderAt(load, {});
    expect(token()).toBe("");
  });
});

describe("signup query", () => {
  const load: Load = () => import("./signup/page");
  const logIn = () => screen.getByRole("link", { name: auth("signup.logIn") });

  it("the log-in link carries a destination the visitor arrived with", async () => {
    await renderAt(load, { next: "/invite/invi_1" });
    expect(logIn()).toHaveAttribute("href", "/login?next=%2Finvite%2Finvi_1");
  });

  it("without one, the log-in link goes to plain /login, not to onboarding (negative)", async () => {
    await renderAt(load, {});
    expect(logIn()).toHaveAttribute("href", "/login");
  });

  it("hands the form an address Verify email's Change it returned", async () => {
    await renderAt(load, { email: " marcus@a-intel.com " });
    expect(screen.getByTestId("signup-form")).toHaveAttribute(
      "data-email",
      "marcus@a-intel.com",
    );
  });

  it("hands the form no malformed address (negative)", async () => {
    await renderAt(load, { email: "not an email" });
    expect(screen.getByTestId("signup-form")).toHaveAttribute(
      "data-email",
      "none",
    );
  });
});

describe("signup allowance tag", () => {
  const load: Load = () => import("./signup/page");
  const tags = () =>
    [...screen.getByTestId("auth-tags").querySelectorAll("li")].map(
      (li) => li.textContent,
    );

  it("draws the allowance tag when the Free plan includes governed actions", async () => {
    includesAllowance.mockResolvedValueOnce(true);
    await renderAt(load, {});
    expect(tags()).toEqual([
      auth("shell.tags.allowance"),
      auth("shell.tags.markup"),
      auth("shell.tags.evidence"),
    ]);
  });

  it("draws no allowance tag when the plan includes none (negative)", async () => {
    includesAllowance.mockResolvedValueOnce(false);
    await renderAt(load, {});
    expect(tags()).toEqual([
      auth("shell.tags.markup"),
      auth("shell.tags.evidence"),
    ]);
  });
});

describe("verify query", () => {
  const load: Load = () => import("./verify/page");
  const panel = () => screen.getByTestId("verify-panel");

  it("echoes a well-formed address in the lead and hands it to the panel", async () => {
    await renderAt(load, { email: " marcus@a-intel.com " });
    // The lead claims no send: a registered address signing up again gets
    // no mail (#4043), so it says what happens if the address is waiting.
    expect(document.body).toHaveTextContent(
      "If marcus@a-intel.com is waiting to be verified, a link is on its way.",
    );
    expect(document.body).not.toHaveTextContent("We sent");
    expect(document.body).not.toHaveTextContent("on this device");
    expect(panel()).toHaveAttribute("data-email", "marcus@a-intel.com");
    expect(panel()).toHaveAttribute("data-expired", "false");
  });

  it.each([
    ["a malformed address", { email: "not an email" }],
    ["no address", {}],
  ])(
    "with %s the lead names none and nothing is echoed (negative)",
    async (_label, query) => {
      await renderAt(load, query);
      expect(document.body).toHaveTextContent(auth("verify.leadNoEmail"));
      expect(document.body).not.toHaveTextContent("not an email");
      expect(panel()).toHaveAttribute("data-email", "none");
    },
  );

  it("Change it returns to sign-up with the address and the destination", async () => {
    await renderAt(load, {
      email: "marcus@a-intel.com",
      next: "/invite/invi_1",
    });
    expect(
      screen.getByRole("link", { name: auth("verify.changeIt") }),
    ).toHaveAttribute(
      "href",
      "/signup?next=%2Finvite%2Finvi_1&email=marcus%40a-intel.com",
    );
  });

  it("Change it carries no address it would not echo, and no default destination (negative)", async () => {
    await renderAt(load, { email: "not an email" });
    expect(
      screen.getByRole("link", { name: auth("verify.changeIt") }),
    ).toHaveAttribute("href", "/signup");
  });

  it("an ?error= from a spent link tells the panel the link expired", async () => {
    await renderAt(load, { error: "TOKEN_EXPIRED" });
    expect(panel()).toHaveAttribute("data-expired", "true");
  });
});
