// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("LoginForm", () => {
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

  it("announces wrong credentials", async () => {
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
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is wrong",
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

  it("a second factor continues at /two-factor carrying next, and remembers it", async () => {
    live.liveSignIn.mockResolvedValue({ ok: true, twoFactor: true });
    renderWithIntl(<LoginForm next={routes.people("acme")} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/two-factor?next=%2Facme");
    });
    expect(live.rememberPendingNext).toHaveBeenCalledWith("/acme");
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

  it("a plain success goes to next", async () => {
    live.liveSignIn.mockResolvedValue({ ok: true, twoFactor: false });
    renderWithIntl(<LoginForm next={routes.people("acme")} />);
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme");
    });
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
  async function fill(password = "mission-control") {
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

  it("validates the password length", async () => {
    renderWithIntl(<SignupForm />);
    await fill("short");
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(live.liveSignUp).not.toHaveBeenCalled();
  });

  it("toggles the password between hidden and shown", async () => {
    renderWithIntl(<SignupForm />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute(
      "aria-pressed",
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
});

describe("TwoFactorForm", () => {
  it("validates six digits", async () => {
    renderWithIntl(<TwoFactorForm next={routes.root()} />);
    await userEvent.type(screen.getByLabelText("Authentication code"), "123");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      screen.getByText("Enter the six digits from your authenticator app."),
    ).toBeInTheDocument();
  });

  it("a wrong code is announced; a good one goes to next", async () => {
    live.liveVerifyTwoFactor.mockResolvedValueOnce({
      ok: false,
      outcome: "codeWrong",
    });
    renderWithIntl(<TwoFactorForm next={routes.people("acme")} />);
    await userEvent.type(
      screen.getByLabelText("Authentication code"),
      "000000",
    );
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That code is wrong",
    );

    live.liveVerifyTwoFactor.mockResolvedValueOnce({ ok: true });
    await userEvent.clear(screen.getByLabelText("Authentication code"));
    await userEvent.type(
      screen.getByLabelText("Authentication code"),
      "602914",
    );
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme");
    });
  });

  it("resumes at the destination remembered before Better Auth's redirect", async () => {
    live.takePendingNext.mockReturnValue("/acme/core-platform");
    live.liveVerifyTwoFactor.mockResolvedValue({ ok: true });
    renderWithIntl(<TwoFactorForm next={routes.root()} />);
    await userEvent.type(
      screen.getByLabelText("Authentication code"),
      "602914",
    );
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme/core-platform");
    });
  });

  it("ignores a remembered destination that is not same-origin", async () => {
    live.takePendingNext.mockReturnValue("//evil.example");
    live.liveVerifyTwoFactor.mockResolvedValue({ ok: true });
    renderWithIntl(<TwoFactorForm next={routes.root()} />);
    await userEvent.type(
      screen.getByLabelText("Authentication code"),
      "602914",
    );
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
    renderWithIntl(<TwoFactorForm next={routes.root()} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Use a recovery code instead" }),
    );
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
    expect(screen.getByLabelText("Authentication code")).toBeInTheDocument();
  });
});

describe("ForgotPasswordForm", () => {
  it("validates, then shows the neutral confirmation, and can send again", async () => {
    actions.requestPasswordReset.mockResolvedValue({
      ok: true,
      to: "/forgot-password",
    });
    renderWithIntl(<ForgotPasswordForm />);
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
      "If an account exists for anyone@acme.example",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send another link" }),
    );
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
  });

  it("reports an action failure as unavailable", async () => {
    actions.requestPasswordReset.mockRejectedValue(new Error("down"));
    renderWithIntl(<ForgotPasswordForm />);
    await userEvent.type(
      screen.getByLabelText("Work email"),
      "anyone@acme.example",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
  });
});

describe("ResetPasswordForm", () => {
  async function submit(a: string, b: string) {
    await userEvent.type(screen.getByLabelText("New password"), a);
    await userEvent.type(screen.getByLabelText("Confirm new password"), b);
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
  }

  it("a missing token is the expired state", () => {
    renderWithIntl(<ResetPasswordForm token="" />);
    expect(screen.getByTestId("reset-expired")).toHaveTextContent(
      "This reset link has expired",
    );
  });

  it("validates matching passwords", async () => {
    renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit("Rq7!mesa-lattice", "Rq7!mesa-latice");
    expect(
      screen.getByText(/The two passwords do not match/),
    ).toBeInTheDocument();
    expect(actions.resetPassword).not.toHaveBeenCalled();
  });

  it("shows done on success and expired on a spent link", async () => {
    actions.resetPassword.mockResolvedValueOnce({ ok: true, to: "/login" });
    const { unmount } = renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit("Rq7!mesa-lattice", "Rq7!mesa-lattice");
    expect(await screen.findByTestId("reset-done")).toBeInTheDocument();
    unmount();

    actions.resetPassword.mockResolvedValueOnce({
      ok: false,
      outcome: "linkExpired",
    });
    renderWithIntl(<ResetPasswordForm token="rst_2" />);
    await submit("Rq7!mesa-lattice", "Rq7!mesa-lattice");
    expect(await screen.findByTestId("reset-expired")).toBeInTheDocument();
  });

  it("shows server field errors and other outcomes", async () => {
    actions.resetPassword.mockResolvedValueOnce({
      ok: false,
      fields: { newPassword: "passwordTooLong" },
    });
    renderWithIntl(<ResetPasswordForm token="rst_1" />);
    await submit("Rq7!mesa-lattice", "Rq7!mesa-lattice");
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
  it("announces a spent link, validates the address and confirms a resend neutrally", async () => {
    actions.resendVerification.mockResolvedValue({ ok: true, to: "/verify" });
    renderWithIntl(
      <VerifyPanel email={null} expired next="/new-organization" />,
    );
    expect(screen.getByTestId("verify-expired")).toBeInTheDocument();
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

  it("prefills the address it was given", () => {
    renderWithIntl(
      <VerifyPanel
        email="m@acme.example"
        expired={false}
        next="/new-organization"
      />,
    );
    expect(screen.getByLabelText("Work email")).toHaveValue("m@acme.example");
    expect(screen.queryByTestId("verify-expired")).toBeNull();
  });
});

describe("InviteDecision", () => {
  it("accept replaces the page with the organization", async () => {
    inviteActions.acceptInvitation.mockResolvedValue({
      ok: true,
      value: { to: "/acme" },
    });
    renderWithIntl(<InviteDecision token="invi_1" orgName="Acme Robotics" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Accept invitation" }),
    );
    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith("/acme");
    });
  });

  it("decline confirms without navigating", async () => {
    inviteActions.declineInvitation.mockResolvedValue({
      ok: true,
      value: { invitationPublicId: "invi_1", status: "declined" },
    });
    renderWithIntl(<InviteDecision token="invi_1" orgName="Acme Robotics" />);
    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(await screen.findByTestId("invite-declined")).toHaveTextContent(
      "Invitation declined. Acme Robotics has been told",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names the refusal: another account, a closed invitation, any other failure", async () => {
    renderWithIntl(<InviteDecision token="invi_1" orgName="Acme Robotics" />);
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
});
