// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { routes } from "@/shared/safe-path";
import { IntlProvider } from "@/test/intl";

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const actions = {
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  resendVerification: vi.fn(),
};
vi.mock("./actions", () => actions);

const live = {
  liveSignIn: vi.fn(),
  liveSignUp: vi.fn(),
  liveVerifyTwoFactor: vi.fn(),
  liveSignInSocial: vi.fn(),
  liveSignInSso: vi.fn(),
  rememberPendingNext: vi.fn(),
  takePendingNext: vi.fn(),
  rememberPendingEmail: vi.fn(),
  takePendingEmail: vi.fn(),
  rememberNotice: vi.fn(),
  takeNotice: vi.fn(),
  rememberSignedIn: vi.fn(),
  takeSignedIn: vi.fn(),
};
vi.mock("./auth-client", () => live);

const inviteActions = { acceptInvitation: vi.fn(), declineInvitation: vi.fn() };
vi.mock("./invite-actions", () => inviteActions);

const { LoginForm } = await import("./login-form");
const { SignupForm } = await import("./signup-form");
const { TwoFactorForm } = await import("./two-factor-form");
const { ForgotPasswordForm, ResetPasswordForm } = await import(
  "./password-reset-forms"
);
const { VerifyPanel } = await import("./verify-panel");
const { InviteDecision } = await import("./invite-decision");
const { OAuthButtons } = await import("./ui/oauth-buttons");
const { InviteHint } = await import("./ui/invite-hint");
const { SignedInToast, SIGNED_IN_TOAST_MS } = await import(
  "./ui/signed-in-toast"
);

function renderWithIntl(ui: React.ReactNode) {
  return render(<IntlProvider>{ui}</IntlProvider>);
}

beforeEach(() => {
  for (const fn of [
    ...Object.values(router),
    ...Object.values(actions),
    ...Object.values(live),
    ...Object.values(inviteActions),
  ]) {
    fn.mockReset();
  }
  // Storage holds no remembered destination unless a test puts one there.
  live.takePendingNext.mockReturnValue(null);
  live.takePendingEmail.mockReturnValue(null);
  live.takeNotice.mockReturnValue(null);
  live.takeSignedIn.mockReturnValue(false);
});

/** A promise that never settles: the form stays in its loading state. */
const hang = () => new Promise<never>(() => {});

/** The accessible names of the buttons, links and inputs in document order. */
function controlOrder(root: HTMLElement): string[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button, a, input:not([type=hidden])",
    ),
  ].map((el) => {
    if (el instanceof HTMLInputElement) return `input#${el.id || el.name}`;
    return (el.textContent ?? "").trim();
  });
}
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("LoginForm", () => {
  it("lays the card out as the design does: providers, or, email, password, remember, log in, then SSO under the card", () => {
    renderWithIntl(
      <LoginForm
        next={routes.root()}
        header={<h1>Log in to Oxagen</h1>}
        footer={<p>footer</p>}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Log in to Oxagen" }),
    ).toBeInTheDocument();
    expect(controlOrder(document.body)).toEqual([
      "Continue with Google",
      "Continue with GitHub",
      "input#login-email",
      "Forgot password?",
      "input#login-password",
      "Show",
      "input#rememberMe",
      "Log in",
      "Sign in with SSO",
    ]);
    // Single sign-on is not part of the design's card.
    expect(screen.getByTestId("login-card")).not.toHaveTextContent(
      "Sign in with SSO",
    );
    expect(screen.getByText("or")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(
      screen.getByRole("link", { name: "Forgot password?" }),
    ).toHaveAttribute("href", "/forgot-password");
    expect(
      screen.getByLabelText("Keep me logged in on this device for 30 days"),
    ).toBeChecked();
    // One gold action on the screen.
    const gold = [...document.querySelectorAll("button, a")].filter((el) =>
      el.className.includes("bg-button-primary-bg"),
    );
    expect(gold.map((el) => el.textContent)).toEqual(["Log in"]);
    expect(screen.getByText("footer")).toBeInTheDocument();
  });

  it("shows a message under each empty field and calls nothing", async () => {
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByText("Enter your work email.")).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText("Work email")).toHaveAccessibleDescription(
      "Enter your work email.",
    );
    expect(live.liveSignIn).not.toHaveBeenCalled();
  });

  it("toggles the password between hidden and shown", async () => {
    renderWithIntl(<LoginForm next={routes.root()} />);
    const input = screen.getByLabelText("Password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("wrong credentials: the alert above the providers in the design's words, the email marked", async () => {
    live.liveSignIn.mockResolvedValue({
      ok: false,
      outcome: "wrongCredentials",
    });
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "marcus.bell@acme.example",
    );
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Email or password is wrong. Check both and try again, or reset your password.",
    );
    expect(alert.querySelector("b")).toHaveTextContent(
      "Email or password is wrong.",
    );
    expect(
      alert.compareDocumentPosition(
        screen.getByRole("button", { name: "Continue with Google" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(live.liveSignIn).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "marcus.bell@acme.example",
        password: "nope",
        rememberMe: true,
      }),
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("loading: the button spins, reads Logging in… and is aria-disabled, and the form stays", async () => {
    live.liveSignIn.mockReturnValue(hang());
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    const busy = await screen.findByRole("button", { name: "Logging in…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Work email")).toHaveValue("a@b.co");
  });

  it("suspended: one full card replaces the header, the form and the footer", async () => {
    live.liveSignIn.mockResolvedValue({ ok: false, outcome: "suspended" });
    renderWithIntl(
      <LoginForm
        next={routes.root()}
        header={<h1>Log in to Oxagen</h1>}
        footer={<p>footer</p>}
      />,
    );
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "marcus@a-intel.example",
    );
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    const state = await screen.findByTestId("login-suspended");
    expect(
      screen.getByRole("heading", { name: "This account is suspended" }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "marcus@a-intel.example is suspended. Runs already recorded are kept; no new run tokens are minted.",
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("footer")).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
    // No gold action on the suspended card.
    expect(document.querySelector(".bg-button-primary-bg")).toBeNull();
  });

  it("a second factor continues at /two-factor carrying next, and remembers it and the address", async () => {
    live.liveSignIn.mockResolvedValue({ ok: true, twoFactor: true });
    renderWithIntl(<LoginForm next={routes.people("acme")} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/two-factor?next=%2Facme");
    });
    expect(live.rememberPendingNext).toHaveBeenCalledWith("/acme");
    expect(live.rememberPendingEmail).toHaveBeenCalledWith("a@b.co");
    // The toast waits for the second factor.
    expect(live.rememberSignedIn).not.toHaveBeenCalled();
  });

  it("an unverified email goes to verify", async () => {
    live.liveSignIn.mockResolvedValue({
      ok: false,
      outcome: "emailNotVerified",
    });
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/verify?email=a%40b.co");
    });
  });

  it("a thrown client error reads as unavailable", async () => {
    live.liveSignIn.mockRejectedValue(new Error("network"));
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign-in is unavailable right now",
    );
  });

  it("a plain success goes to next and leaves the signed-in toast for it", async () => {
    live.liveSignIn.mockResolvedValue({ ok: true, twoFactor: false });
    renderWithIntl(<LoginForm next={routes.people("acme")} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme");
    });
    expect(live.rememberSignedIn).toHaveBeenCalledTimes(1);
  });

  it("drops a signed-in mark a failed sign-in left behind, once (negative)", () => {
    renderWithIntl(
      <StrictMode>
        <LoginForm next={routes.root()} initialOutcome="oauthFailed" />
      </StrictMode>,
    );
    expect(live.takeSignedIn).toHaveBeenCalledTimes(1);
    expect(live.rememberSignedIn).not.toHaveBeenCalled();
  });

  it("after a reset it says the password is set, once", async () => {
    live.takeNotice.mockReturnValue("passwordSet");
    renderWithIntl(<LoginForm next={routes.root()} />);
    expect(await screen.findByTestId("login-notice")).toHaveTextContent(
      "Password set. Every other device was logged out.",
    );
    expect(live.takeNotice).toHaveBeenCalledTimes(1);
  });
});

describe("InviteHint", () => {
  it("Accept it says where the invitation opens", async () => {
    renderWithIntl(
      <p>
        <InviteHint />
      </p>,
    );
    const button = screen.getByRole("button", { name: "Accept it" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Open the link in your invitation email to accept it.",
    );
  });
});

describe("LoginForm SSO entry", () => {
  const ssoForm = () => screen.getByRole("form", { name: "Single sign-on" });

  it("starts closed, opens on demand, and starts SSO for the email toward next", async () => {
    live.liveSignInSso.mockReturnValue(new Promise(() => {}));
    renderWithIntl(<LoginForm next={routes.people("acme")} />);
    expect(
      screen.queryByRole("form", { name: "Single sign-on" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in with SSO" }),
    );
    await userEvent.type(
      within(ssoForm()).getByLabelText("Work email"),
      "marcus.bell@acme.example",
    );
    await userEvent.click(
      within(ssoForm()).getByRole("button", { name: "Continue with SSO" }),
    );
    expect(live.liveSignInSso).toHaveBeenCalledWith({
      email: "marcus.bell@acme.example",
      callbackURL: "/acme",
    });
    expect(live.liveSignIn).not.toHaveBeenCalled();
    // Marked before the browser leaves for the identity provider.
    expect(live.rememberSignedIn).toHaveBeenCalledTimes(1);
  });

  it("validates the email before calling anything", async () => {
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in with SSO" }),
    );
    await userEvent.click(
      within(ssoForm()).getByRole("button", { name: "Continue with SSO" }),
    );
    expect(
      within(ssoForm()).getByText("Enter your work email."),
    ).toBeInTheDocument();
    expect(live.liveSignInSso).not.toHaveBeenCalled();
  });

  it("shows a domain with no provider in the SSO form", async () => {
    live.liveSignInSso.mockResolvedValue({
      ok: false,
      outcome: "ssoNoProvider",
    });
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in with SSO" }),
    );
    await userEvent.type(
      within(ssoForm()).getByLabelText("Work email"),
      "a@nowhere.example",
    );
    await userEvent.click(
      within(ssoForm()).getByRole("button", { name: "Continue with SSO" }),
    );
    expect(await within(ssoForm()).findByRole("alert")).toHaveTextContent(
      "No single sign-on is set up for this email domain.",
    );
  });

  it("opens by default under ?sso=required and says why", () => {
    renderWithIntl(<LoginForm next={routes.people("acme")} ssoRequired />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your organization requires single sign-on.",
    );
    expect(ssoForm()).toBeInTheDocument();
  });

  it("a password refused with SSO_REQUIRED says so and opens the SSO entry", async () => {
    live.liveSignIn.mockResolvedValue({ ok: false, outcome: "ssoRequired" });
    renderWithIntl(<LoginForm next={routes.root()} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@acme.example");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByTestId("login-outcome")).toHaveTextContent(
      "Your organization requires single sign-on for this email.",
    );
    expect(ssoForm()).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("an identity-provider failure from ?error= shows in the SSO form, not the password form", () => {
    renderWithIntl(
      <LoginForm next={routes.root()} initialOutcome="ssoFailed" />,
    );
    expect(within(ssoForm()).getByRole("alert")).toHaveTextContent(
      "Single sign-on did not finish.",
    );
    expect(screen.queryByTestId("login-outcome")).not.toBeInTheDocument();
  });
});

describe("SignupForm", () => {
  const STRONG = "mission-control-9";

  async function fill(password = STRONG) {
    await userEvent.type(screen.getByLabelText("Name"), "Marcus Bell");
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "marcus.bell@acme.example",
    );
    await userEvent.type(screen.getByLabelText("Password"), password);
    await userEvent.click(
      screen.getByRole("button", { name: "Create account" }),
    );
  }

  it("lays the card out as the design does, with the terms under the button", () => {
    renderWithIntl(<SignupForm />);
    expect(controlOrder(document.body)).toEqual([
      "Continue with Google",
      "Continue with GitHub",
      "input#signup-name",
      "input#signup-email",
      "input#signup-password",
      "Show",
      "Create account",
    ]);
    expect(screen.getByLabelText("Name")).toHaveAttribute(
      "autocomplete",
      "name",
    );
    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(document.body).toHaveTextContent(
      "By creating an account you agree to the Oxagen terms and privacy notice. Oxagen never stores your model provider keys in plain text, and never returns them once saved.",
    );
  });

  it("the meter and the three requirements tick as the password meets them", async () => {
    renderWithIntl(<SignupForm />);
    const list = screen.getByRole("list", { name: "Password requirements" });
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      /at least 12 characters/,
    );
    expect(screen.getByTestId("password-meter")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const lit = () =>
      screen.getByTestId("password-meter").querySelectorAll("[data-on]").length;
    expect(lit()).toBe(0);
    expect(within(list).getAllByText("not met")).toHaveLength(3);
    await userEvent.type(screen.getByLabelText("Password"), "abcd");
    expect(lit()).toBe(1);
    await userEvent.type(screen.getByLabelText("Password"), "-");
    expect(within(list).getByText("one symbol").closest("li")).toHaveAttribute(
      "data-met",
      "true",
    );
    expect(
      within(list).getByText("one digit").closest("li"),
    ).not.toHaveAttribute("data-met");
    await userEvent.type(screen.getByLabelText("Password"), "efgh-ijk9");
    expect(lit()).toBe(3);
    expect(within(list).getAllByText("met")).toHaveLength(3);
  });

  it.each([
    ["short-1", "Use at least 12 characters."],
    ["missioncontrol9", "Add a symbol."],
    ["mission-control", "Add a digit."],
  ])("refuses %s before calling anything", async (password, message) => {
    renderWithIntl(<SignupForm />);
    await fill(password);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(live.liveSignUp).not.toHaveBeenCalled();
  });

  it("toggles the password between hidden and shown", async () => {
    renderWithIntl(<SignupForm />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    // The word alone names the state, as the design draws it.
    expect(screen.getByRole("button", { name: "Hide" })).toHaveTextContent(
      /^Hide$/,
    );
  });

  it("loading: Creating account… is aria-disabled and the form stays", async () => {
    live.liveSignUp.mockReturnValue(hang());
    renderWithIntl(<SignupForm />);
    await fill();
    expect(
      await screen.findByRole("button", { name: "Creating account…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Name")).toHaveValue("Marcus Bell");
  });

  it("a registered address: the alert in the design's words above the providers, the email marked", async () => {
    live.liveSignUp.mockResolvedValue({
      ok: false,
      outcome: "alreadyRegistered",
    });
    renderWithIntl(<SignupForm />);
    await fill();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "That email is already registered. Log in instead, or reset your password.",
    );
    expect(alert.querySelector("b")).toHaveTextContent(
      "That email is already registered.",
    );
    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("a deployment that requires verification sends the new account to verify", async () => {
    live.liveSignUp.mockResolvedValue({ ok: true, needsVerification: true });
    renderWithIntl(<SignupForm next={routes.invite("invi_1")} />);
    await fill();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(
        "/verify?email=marcus.bell%40acme.example&next=%2Finvite%2Finvi_1",
      );
    });
  });

  it("otherwise straight to next", async () => {
    live.liveSignUp.mockResolvedValue({ ok: true, needsVerification: false });
    renderWithIntl(<SignupForm />);
    await fill();
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/new-organization");
    });
  });

  it("a refusal is announced", async () => {
    live.liveSignUp.mockResolvedValue({ ok: false, outcome: "rateLimited" });
    renderWithIntl(<SignupForm />);
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts",
    );
  });

  it("social sign-up continues to the page's next", async () => {
    live.liveSignInSocial.mockResolvedValue({ ok: true });
    renderWithIntl(<SignupForm />);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    await waitFor(() => {
      expect(live.liveSignInSocial).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/new-organization",
      });
    });
  });
});

describe("TwoFactorForm", () => {
  const renderForm = (next = routes.root()) =>
    renderWithIntl(
      <TwoFactorForm
        next={next}
        eyebrow="Step 2 of 2"
        title="Two-factor authentication"
      />,
    );
  const box = (n: number) =>
    screen.getByRole("textbox", { name: `digit ${n}` });

  async function typeCode(code: string) {
    await userEvent.click(box(1));
    await userEvent.keyboard(code);
  }

  it("renders the header, six numeric one-digit boxes, the recovery switch and the expiry", async () => {
    live.takePendingEmail.mockReturnValue("marcus@a-intel.example");
    renderForm();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Two-factor authentication",
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(document.body).toHaveTextContent(
        "Enter the six-digit code from your authenticator app for marcus@a-intel.example.",
      );
    });
    expect(
      screen.getByRole("group", { name: "Authentication code" }),
    ).toBeInTheDocument();
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(box(n)).toHaveAttribute("inputmode", "numeric");
      expect(box(n)).toHaveAttribute("id", `two-factor-code-${n}`);
    }
    expect(box(2)).toHaveAttribute("maxlength", "1");
    expect(
      screen.getByRole("button", { name: "Use a recovery code instead" }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("two-factor-expiry")).toHaveTextContent(
      /^expires 0:\d{2}$/,
    );
  });

  it("takes the remembered address once, even when React runs effects twice", async () => {
    live.takePendingEmail.mockReturnValueOnce("marcus@a-intel.example");
    render(
      <StrictMode>
        <IntlProvider>
          <TwoFactorForm
            next={routes.root()}
            eyebrow="Step 2 of 2"
            title="Two-factor authentication"
          />
        </IntlProvider>
      </StrictMode>,
    );
    await waitFor(() => {
      expect(document.body).toHaveTextContent("marcus@a-intel.example");
    });
    expect(live.takePendingEmail).toHaveBeenCalledTimes(1);
  });

  it("without a remembered address the lead names none", () => {
    renderForm();
    expect(document.body).toHaveTextContent(
      "Enter the six-digit code from your authenticator app.",
    );
  });

  it("typing moves forward, Backspace on an empty box moves back", async () => {
    renderForm();
    await typeCode("12");
    expect(box(1)).toHaveValue("1");
    expect(box(2)).toHaveValue("2");
    expect(box(3)).toHaveFocus();
    await userEvent.keyboard("{Backspace}");
    expect(box(2)).toHaveFocus();
    expect(box(2)).toHaveValue("");
    await userEvent.keyboard("{ArrowLeft}");
    expect(box(1)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(box(2)).toHaveFocus();
  });

  it("a pasted code fills every box", async () => {
    live.liveVerifyTwoFactor.mockResolvedValue({ ok: true });
    renderForm();
    await userEvent.click(box(1));
    await userEvent.paste("602 914");
    expect(
      [1, 2, 3, 4, 5, 6].map((n) => (box(n) as HTMLInputElement).value),
    ).toEqual(["6", "0", "2", "9", "1", "4"]);
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(live.liveVerifyTwoFactor).toHaveBeenCalledWith({
        method: "totp",
        code: "602914",
      });
    });
  });

  it("validates six digits", async () => {
    renderForm();
    await typeCode("123");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      screen.getByText("Enter the six digits from your authenticator app."),
    ).toBeInTheDocument();
    expect(box(1)).toHaveAttribute("aria-invalid", "true");
    expect(live.liveVerifyTwoFactor).not.toHaveBeenCalled();
  });

  it("loading: Verifying… is aria-disabled and the boxes keep the code", async () => {
    live.liveVerifyTwoFactor.mockReturnValue(hang());
    renderForm();
    await typeCode("602914");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      await screen.findByRole("button", { name: "Verifying…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(box(6)).toHaveValue("4");
  });

  it("a wrong code is announced and empties the boxes; a good one goes to next", async () => {
    live.liveVerifyTwoFactor.mockResolvedValueOnce({
      ok: false,
      outcome: "codeWrong",
    });
    renderForm(routes.people("acme"));
    await typeCode("000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("b")).toHaveTextContent("That code is wrong.");
    for (const n of [1, 2, 3, 4, 5, 6]) expect(box(n)).toHaveValue("");
    expect(box(1)).toHaveFocus();

    expect(live.rememberSignedIn).not.toHaveBeenCalled();

    live.liveVerifyTwoFactor.mockResolvedValueOnce({ ok: true });
    await typeCode("602914");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme");
    });
    // The destination shows "Signed in as …" once.
    expect(live.rememberSignedIn).toHaveBeenCalledTimes(1);
  });

  it("resumes at the destination remembered before Better Auth's redirect", async () => {
    live.takePendingNext.mockReturnValue("/acme/core-platform");
    live.liveVerifyTwoFactor.mockResolvedValue({ ok: true });
    renderForm();
    await typeCode("602914");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme/core-platform");
    });
  });

  it("ignores a remembered destination that is not same-origin", async () => {
    live.takePendingNext.mockReturnValue("//evil.example");
    live.liveVerifyTwoFactor.mockResolvedValue({ ok: true });
    renderForm();
    await typeCode("602914");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/");
    });
  });

  it("switches to a recovery code and back", async () => {
    live.liveVerifyTwoFactor.mockResolvedValue({
      ok: false,
      outcome: "codeWrong",
    });
    renderForm();
    await userEvent.click(
      screen.getByRole("button", { name: "Use a recovery code instead" }),
    );
    expect(screen.queryByTestId("two-factor-expiry")).toBeNull();
    await userEvent.type(screen.getByLabelText("Recovery code"), "AbCd3-fGh1j");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(live.liveVerifyTwoFactor).toHaveBeenCalledWith({
        method: "backup",
        code: "AbCd3-fGh1j",
      });
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: "Use your authenticator app instead",
      }),
    );
    expect(
      screen.getByRole("group", { name: "Authentication code" }),
    ).toBeInTheDocument();
  });
});

describe("ForgotPasswordForm", () => {
  const frame = {
    header: <h1>Reset your password</h1>,
    footer: <p>Back to log in</p>,
  };

  it("validates, then replaces the page with the success-toned sent card and keeps the footer", async () => {
    actions.requestPasswordReset.mockResolvedValue({
      ok: true,
      to: "/forgot-password",
    });
    renderWithIntl(<ForgotPasswordForm {...frame} />);
    expect(screen.getByLabelText("Work email")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    expect(screen.getByText("Enter your work email.")).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "anyone@acme.example",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    expect(await screen.findByTestId("forgot-sent")).toHaveTextContent(
      "Reset link sentIf an account exists for anyone@acme.example a reset link is on its way. The link is good for 60 minutes and can be used once.",
    );
    // The design's `ob-state ok`: the Inbox glyph on the success tone.
    const glyph = screen
      .getByTestId("forgot-sent")
      .querySelector("svg")?.parentElement;
    expect(glyph?.className).toContain("text-success");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByText("Back to log in")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("loading: Sending… is aria-disabled and the address stays", async () => {
    actions.requestPasswordReset.mockReturnValue(hang());
    renderWithIntl(<ForgotPasswordForm {...frame} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    expect(
      await screen.findByRole("button", { name: "Sending…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Work email")).toHaveValue("a@b.co");
  });

  it("an action that fails says the email was not sent", async () => {
    actions.requestPasswordReset.mockRejectedValue(new Error("down"));
    renderWithIntl(<ForgotPasswordForm {...frame} />);
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "anyone@acme.example",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("b")).toHaveTextContent(
      "We could not send that email.",
    );
    expect(alert).toHaveTextContent("Try again in a minute.");
  });
});

describe("ResetPasswordForm", () => {
  const STRONG = "Rq7!mesa-lattice";

  async function submit(a: string, b: string) {
    await userEvent.type(screen.getByLabelText("New password"), a);
    await userEvent.type(screen.getByLabelText("Confirm new password"), b);
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
  }

  it("a missing token is the expired card, in place of the header", () => {
    renderWithIntl(
      <ResetPasswordForm token="" header={<h1>Set a new password</h1>} />,
    );
    expect(screen.getByTestId("reset-expired")).toHaveTextContent(
      "This reset link has expiredReset links last 60 minutes and can be used once. Request a new one and it will arrive in under a minute.",
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const request = screen.getByRole("link", { name: "Request a new link" });
    expect(request).toHaveAttribute("href", "/forgot-password");
    expect(request.className).not.toContain("bg-button-primary-bg");
  });

  it("carries the meter and requirements, and no footer link", () => {
    renderWithIntl(
      <ResetPasswordForm token="rst_1" header={<h1>Set a new password</h1>} />,
    );
    expect(
      screen.getByRole("list", { name: "Password requirements" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a mismatch is the alert above the form, with the confirmation marked", async () => {
    renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit(STRONG, "Rq7!mesa-latice");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "The two passwords do not match. Retype the confirmation.",
    );
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getAllByText(/do not match/)).toHaveLength(1);
    expect(actions.resetPassword).not.toHaveBeenCalled();
  });

  it("loading: Saving… is aria-disabled", async () => {
    actions.resetPassword.mockReturnValue(hang());
    renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit(STRONG, STRONG);
    expect(
      await screen.findByRole("button", { name: "Saving…" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("success returns to Log in with the notice; a spent link is the expired card", async () => {
    actions.resetPassword.mockResolvedValueOnce({ ok: true, to: "/login" });
    const { unmount } = renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit(STRONG, STRONG);
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/login");
    });
    expect(live.rememberNotice).toHaveBeenCalledWith("passwordSet");
    expect(actions.resetPassword).toHaveBeenCalledWith({
      token: "rst_1",
      newPassword: STRONG,
      confirmPassword: STRONG,
    });
    unmount();

    actions.resetPassword.mockResolvedValueOnce({
      ok: false,
      outcome: "linkExpired",
    });
    renderWithIntl(<ResetPasswordForm token="rst_2" />);
    await submit(STRONG, STRONG);
    expect(await screen.findByTestId("reset-expired")).toBeInTheDocument();
  });

  it("shows server field errors and other outcomes", async () => {
    actions.resetPassword.mockResolvedValueOnce({
      ok: false,
      fields: { newPassword: "passwordTooLong" },
    });
    renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit(STRONG, STRONG);
    expect(
      await screen.findByText("Use at most 128 characters."),
    ).toBeInTheDocument();
    actions.resetPassword.mockResolvedValueOnce({
      ok: false,
      outcome: "rateLimited",
    });
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts",
    );
  });
});

describe("VerifyPanel", () => {
  it("with the address: Did not arrive? and a resend that sends it", async () => {
    actions.resendVerification.mockResolvedValue({ ok: true, to: "/verify" });
    renderWithIntl(
      <VerifyPanel
        email="m@acme.example"
        expired={false}
        next="/new-organization"
      />,
    );
    expect(screen.queryByLabelText("Work email")).toBeNull();
    expect(screen.queryByTestId("verify-expired")).toBeNull();
    expect(document.body).toHaveTextContent("Did not arrive?");
    await userEvent.click(
      screen.getByRole("button", { name: "Send a new link" }),
    );
    expect(await screen.findByTestId("verify-resent")).toHaveTextContent(
      "If an account for that address is waiting to be verified, a new link is on its way.",
    );
    expect(actions.resendVerification).toHaveBeenCalledWith({
      email: "m@acme.example",
      next: "/new-organization",
    });
  });

  it("without one: announces a spent link, validates the address and confirms a resend neutrally", async () => {
    actions.resendVerification.mockResolvedValue({ ok: true, to: "/verify" });
    renderWithIntl(
      <VerifyPanel email={null} expired next="/new-organization" />,
    );
    const alert = screen.getByTestId("verify-expired");
    expect(alert).toHaveTextContent(
      "That link has expired. Links last 60 minutes. Send a new one below.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send a new link" }),
    );
    expect(screen.getByText("Enter your work email.")).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "marcus.bell@acme.example",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send a new link" }),
    );
    expect(await screen.findByTestId("verify-resent")).toBeInTheDocument();
    expect(actions.resendVerification).toHaveBeenCalledWith({
      email: "marcus.bell@acme.example",
      next: "/new-organization",
    });
  });

  it("a refused address shows under the resend", async () => {
    actions.resendVerification.mockResolvedValue({
      ok: false,
      fields: { email: "emailInvalid" },
    });
    renderWithIntl(
      <VerifyPanel email="m@acme.example" expired={false} next="/x" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send a new link" }),
    );
    expect(
      await screen.findByText("Enter an email address like name@company.com."),
    ).toBeInTheDocument();
  });
});

describe("InviteDecision", () => {
  it("accept replaces the page with the action's landing and leaves the signed-in toast for it", async () => {
    inviteActions.acceptInvitation.mockResolvedValue({
      ok: true,
      value: { to: "/acme/core-platform" },
    });
    renderWithIntl(<InviteDecision token="invi_1" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Accept invitation" }),
    );
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme/core-platform");
    });
    expect(live.rememberSignedIn).toHaveBeenCalledTimes(1);
  });

  it("loading: Accepting… on Accept while Decline stays", async () => {
    inviteActions.acceptInvitation.mockReturnValue(hang());
    renderWithIntl(<InviteDecision token="invi_1" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Accept invitation" }),
    );
    expect(
      await screen.findByRole("button", { name: "Accepting…" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });

  it("decline confirms without navigating and claims nothing else", async () => {
    inviteActions.declineInvitation.mockResolvedValue({
      ok: true,
      value: { invitationPublicId: "invi_1", status: "declined" },
    });
    renderWithIntl(<InviteDecision token="invi_1" />);
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByTestId("invite-declined")).toHaveTextContent(
      "Invitation declined. Nothing else changes.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names the refusal: another account, a closed invitation, any other failure", async () => {
    renderWithIntl(<InviteDecision token="invi_1" />);
    const accept = () =>
      userEvent.click(
        screen.getByRole("button", { name: "Accept invitation" }),
      );
    inviteActions.acceptInvitation.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "wrong_email",
    });
    await accept();
    expect(await screen.findByTestId("invite-failure")).toHaveTextContent(
      "This account may not answer this invitation",
    );
    inviteActions.declineInvitation.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "invitation_expired",
    });
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByTestId("invite-failure")).toHaveTextContent(
      "This invitation is closed",
    );
    inviteActions.acceptInvitation.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "kernel_failure",
    });
    await accept();
    expect(await screen.findByTestId("invite-failure")).toHaveTextContent(
      "could not be accepted",
    );
    inviteActions.acceptInvitation.mockRejectedValueOnce(new Error("boom"));
    await accept();
    expect(await screen.findByTestId("invite-failure")).toHaveTextContent(
      "could not be accepted",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("OAuthButtons", () => {
  it("starts social sign-in with the sanitised callback", async () => {
    live.liveSignInSocial.mockResolvedValue({ ok: true });
    renderWithIntl(<OAuthButtons callbackURL={routes.people("acme")} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );
    await waitFor(() => {
      expect(live.liveSignInSocial).toHaveBeenCalledWith({
        provider: "github",
        callbackURL: "/acme",
      });
    });
  });

  it("shows a catalog alert when social sign-in fails without leaving the page", async () => {
    live.liveSignInSocial.mockResolvedValue({
      ok: false,
      outcome: "oauthFailed",
    });
    renderWithIntl(<OAuthButtons callbackURL={routes.root()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    expect(await screen.findByTestId("oauth-outcome")).toHaveTextContent(
      "did not finish",
    );
  });

  it("draws the two providers, then the or rule, with Google's mark in its four colours", () => {
    renderWithIntl(<OAuthButtons callbackURL={routes.root()} />);
    expect(controlOrder(document.body)).toEqual([
      "Continue with Google",
      "Continue with GitHub",
    ]);
    expect(screen.getByText("or")).toHaveAttribute("aria-hidden", "true");
    const google = document.querySelector('svg[data-mark="google"]');
    expect(
      [...(google?.querySelectorAll("path") ?? [])].map((p) =>
        p.getAttribute("fill"),
      ),
    ).toEqual(["#4285F4", "#34A853", "#FBBC05", "#EA4335"]);
  });

  it("on Log in, marks the sign-in before leaving for the provider", async () => {
    live.liveSignInSocial.mockResolvedValue({ ok: true });
    renderWithIntl(<OAuthButtons callbackURL={routes.root()} announceSignIn />);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    await waitFor(() => {
      expect(live.liveSignInSocial).toHaveBeenCalled();
    });
    expect(live.rememberSignedIn).toHaveBeenCalledTimes(1);
    expect(live.takeSignedIn).not.toHaveBeenCalled();
  });

  it("drops the mark when the provider start fails here, and never marks on Sign up (negative)", async () => {
    live.liveSignInSocial.mockResolvedValue({
      ok: false,
      outcome: "oauthFailed",
    });
    const { unmount } = renderWithIntl(
      <OAuthButtons callbackURL={routes.root()} announceSignIn />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );
    await screen.findByTestId("oauth-outcome");
    expect(live.takeSignedIn).toHaveBeenCalledTimes(1);
    unmount();
    live.rememberSignedIn.mockClear();
    live.liveSignInSocial.mockResolvedValue({ ok: true });
    renderWithIntl(<OAuthButtons callbackURL={routes.root()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );
    await waitFor(() => {
      expect(live.liveSignInSocial).toHaveBeenCalledTimes(2);
    });
    expect(live.rememberSignedIn).not.toHaveBeenCalled();
  });
});

describe("SignedInToast", () => {
  it("shows the design's sentence once when a sign-in just landed, in a polite live region, then leaves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      live.takeSignedIn.mockReturnValue(true);
      renderWithIntl(
        <StrictMode>
          <SignedInToast name="Marcus Bell" />
        </StrictMode>,
      );
      const toast = await screen.findByTestId("signed-in-toast");
      expect(toast).toHaveTextContent(
        "Signed in as Marcus Bell. The session is recorded like any other governed action.",
      );
      expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
      // Taken once, even when React runs effects twice.
      expect(live.takeSignedIn).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SIGNED_IN_TOAST_MS);
      });
      expect(screen.queryByTestId("signed-in-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows nothing on a page no sign-in landed on (negative)", () => {
    renderWithIntl(<SignedInToast name="Marcus Bell" />);
    expect(screen.queryByTestId("signed-in-toast")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});
