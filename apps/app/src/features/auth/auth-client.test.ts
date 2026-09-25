// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  signIn: { email: vi.fn(), social: vi.fn(), sso: vi.fn() },
  signUp: { email: vi.fn() },
  twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
  requestPasswordReset: vi.fn(),
  sendVerificationEmail: vi.fn(),
  resetPassword: vi.fn(),
};
vi.mock("@oxagen/auth/client", () => ({ authClient: client }));

const auth = await import("./auth-client");
const { routes } = await import("@/shared/safe-path");

beforeEach(() => {
  client.signIn.email.mockReset();
  client.signIn.social.mockReset();
  client.signIn.sso.mockReset();
  client.signUp.email.mockReset();
  client.twoFactor.verifyTotp.mockReset();
  client.twoFactor.verifyBackupCode.mockReset();
  client.requestPasswordReset.mockReset();
  client.sendVerificationEmail.mockReset();
  client.resetPassword.mockReset();
  sessionStorage.clear();
});

describe("liveSignIn", () => {
  it("reports a second factor", async () => {
    client.signIn.email.mockResolvedValue({
      data: { twoFactorRedirect: true },
      error: null,
    });
    await expect(
      auth.liveSignIn({ email: "a@b.co", password: "x", rememberMe: true }),
    ).resolves.toEqual({ ok: true, twoFactor: true });
  });

  it("maps a refusal to its outcome", async () => {
    client.signIn.email.mockResolvedValue({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", status: 401 },
    });
    await expect(
      auth.liveSignIn({ email: "a@b.co", password: "x", rememberMe: false }),
    ).resolves.toEqual({
      ok: false,
      outcome: "wrongCredentials",
    });
  });
});

describe("liveSignUp", () => {
  it("needs verification when Better Auth issues no session token", async () => {
    client.signUp.email.mockResolvedValue({
      data: { token: null, user: {} },
      error: null,
    });
    await expect(
      auth.liveSignUp({ name: "M", email: "a@b.co", password: "longenough" }),
    ).resolves.toEqual({
      ok: true,
      needsVerification: true,
    });
    client.signUp.email.mockResolvedValue({
      data: { token: "t" },
      error: null,
    });
    await expect(
      auth.liveSignUp({ name: "M", email: "a@b.co", password: "longenough" }),
    ).resolves.toEqual({
      ok: true,
      needsVerification: false,
    });
  });

  it("maps an existing account", async () => {
    client.signUp.email.mockResolvedValue({
      error: { code: "USER_ALREADY_EXISTS" },
    });
    await expect(
      auth.liveSignUp({ name: "M", email: "a@b.co", password: "longenough" }),
    ).resolves.toEqual({
      ok: false,
      outcome: "alreadyRegistered",
    });
  });

  it("a success that carries no data holds no session, so it needs verification", async () => {
    client.signUp.email.mockResolvedValue({ data: null, error: null });
    await expect(
      auth.liveSignUp({ name: "M", email: "a@b.co", password: "longenough" }),
    ).resolves.toEqual({
      ok: true,
      needsVerification: true,
    });
  });
});

describe("liveVerifyTwoFactor", () => {
  it("verifies an authenticator code or a recovery code", async () => {
    client.twoFactor.verifyTotp.mockResolvedValue({ data: {}, error: null });
    await expect(
      auth.liveVerifyTwoFactor({ method: "totp", code: "602914" }),
    ).resolves.toEqual({ ok: true });
    client.twoFactor.verifyBackupCode.mockResolvedValue({
      error: { code: "INVALID_BACKUP_CODE" },
    });
    await expect(
      auth.liveVerifyTwoFactor({ method: "backup", code: "AbCd3-fGh1j" }),
    ).resolves.toEqual({
      ok: false,
      outcome: "codeWrong",
    });
  });
});

describe("liveSignInSso", () => {
  it("starts SSO with the email and destination, and a bare login error URL", async () => {
    client.signIn.sso.mockResolvedValue({
      data: { url: "https://idp.acme.example/authorize", redirect: true },
      error: null,
    });
    await expect(
      auth.liveSignInSso({
        email: "m@acme.example",
        callbackURL: routes.fleet("acme", "core"),
      }),
    ).resolves.toEqual({ ok: true });
    expect(client.signIn.sso).toHaveBeenCalledWith({
      email: "m@acme.example",
      callbackURL: "/acme/core",
      // The plugin appends "?error=" blindly, so the error URL carries no query.
      errorCallbackURL: "/login",
    });
  });

  it("maps the plugin's refusals", async () => {
    client.signIn.sso.mockResolvedValue({
      error: { status: 404, message: "No provider found for the issuer" },
    });
    await expect(
      auth.liveSignInSso({
        email: "m@nowhere.example",
        callbackURL: routes.root(),
      }),
    ).resolves.toEqual({ ok: false, outcome: "ssoNoProvider" });
    client.signIn.sso.mockResolvedValue({
      error: { status: 401, message: "Provider domain has not been verified" },
    });
    await expect(
      auth.liveSignInSso({
        email: "m@acme.example",
        callbackURL: routes.root(),
      }),
    ).resolves.toEqual({ ok: false, outcome: "ssoDomainUnverified" });
  });
});

describe("liveSignInSocial", () => {
  it("starts social sign-in with the SafePath callback and a login error URL carrying next", async () => {
    client.signIn.social.mockResolvedValue({});
    await expect(
      auth.liveSignInSocial({
        provider: "github",
        callbackURL: routes.fleet("acme", "core"),
      }),
    ).resolves.toEqual({ ok: true });
    expect(client.signIn.social).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/acme/core",
      // A retry from /login after a failed round-trip still lands on the
      // destination the visitor originally asked for.
      errorCallbackURL: "/login?next=%2Facme%2Fcore",
    });
  });

  it("drops next from the login error URL when the destination is the root", async () => {
    client.signIn.social.mockResolvedValue({});
    await expect(
      auth.liveSignInSocial({
        provider: "github",
        callbackURL: routes.root(),
      }),
    ).resolves.toEqual({ ok: true });
    expect(client.signIn.social).toHaveBeenCalledWith({
      provider: "github",
      callbackURL: "/",
      errorCallbackURL: "/login",
    });
  });

  it("maps a Better Auth social failure to an outcome", async () => {
    client.signIn.social.mockResolvedValue({
      error: { code: "ACCESS_DENIED", status: 403 },
    });
    await expect(
      auth.liveSignInSocial({
        provider: "google",
        callbackURL: routes.root(),
      }),
    ).resolves.toEqual({ ok: false, outcome: "oauthCancelled" });
  });
});

// #4042: these three calls go to Better Auth over HTTP, where its rate
// limiter runs. A 429 from it is the one failure the forms show; every other
// failure of a mail request reads as sent, so the reply never says whether an
// account exists.
const LIMITED = {
  data: null,
  error: { code: "TOO_MANY_REQUESTS", status: 429, message: "Too many" },
};

describe("liveRequestPasswordReset", () => {
  it("asks Better Auth for a reset link to /reset-password", async () => {
    client.requestPasswordReset.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    await expect(
      auth.liveRequestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true });
    expect(client.requestPasswordReset).toHaveBeenCalledWith({
      email: "m@acme.example",
      redirectTo: "/reset-password",
    });
  });

  it("reports the rate limit when Better Auth refuses with 429", async () => {
    client.requestPasswordReset.mockResolvedValue(LIMITED);
    await expect(
      auth.liveRequestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: false, outcome: "rateLimited" });
  });

  it("answers sent for any other failure, so no address is revealed (negative)", async () => {
    client.requestPasswordReset.mockResolvedValue({
      data: null,
      error: { code: "USER_NOT_FOUND", status: 400 },
    });
    await expect(
      auth.liveRequestPasswordReset({ email: "nobody@acme.example" }),
    ).resolves.toEqual({ ok: true });
    client.requestPasswordReset.mockResolvedValue({
      data: null,
      error: { status: 500 },
    });
    await expect(
      auth.liveRequestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("liveResendVerification", () => {
  it("sends a verification link that lands on a safe next, or on the new-organization step", async () => {
    client.sendVerificationEmail.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    await expect(
      auth.liveResendVerification({
        email: "m@acme.example",
        next: "/acme/ws",
      }),
    ).resolves.toEqual({ ok: true });
    expect(client.sendVerificationEmail).toHaveBeenLastCalledWith({
      email: "m@acme.example",
      callbackURL: "/acme/ws",
    });
    await auth.liveResendVerification({
      email: "m@acme.example",
      next: "https://evil.example/x",
    });
    expect(client.sendVerificationEmail).toHaveBeenLastCalledWith({
      email: "m@acme.example",
      callbackURL: routes.newOrganization(),
    });
  });

  it("reports the rate limit when Better Auth refuses with 429", async () => {
    client.sendVerificationEmail.mockResolvedValue(LIMITED);
    await expect(
      auth.liveResendVerification({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: false, outcome: "rateLimited" });
  });

  it("answers sent for any other failure (negative)", async () => {
    client.sendVerificationEmail.mockResolvedValue({
      data: null,
      error: { status: 400, code: "USER_NOT_FOUND" },
    });
    await expect(
      auth.liveResendVerification({ email: "nobody@acme.example" }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("liveResetPassword", () => {
  const input = { token: "rst_live", newPassword: "Rq7!mesa-lattice" };

  it("sets the password through Better Auth", async () => {
    client.resetPassword.mockResolvedValue({
      data: { status: true },
      error: null,
    });
    await expect(auth.liveResetPassword(input)).resolves.toEqual({
      ok: true,
    });
    expect(client.resetPassword).toHaveBeenCalledWith(input);
  });

  it("reports the rate limit when Better Auth refuses with 429", async () => {
    client.resetPassword.mockResolvedValue(LIMITED);
    await expect(auth.liveResetPassword(input)).resolves.toEqual({
      ok: false,
      outcome: "rateLimited",
    });
  });

  it("maps a spent token to linkExpired and an unrecognised failure to unavailable", async () => {
    client.resetPassword.mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_TOKEN", status: 400 },
    });
    await expect(auth.liveResetPassword(input)).resolves.toEqual({
      ok: false,
      outcome: "linkExpired",
    });
    client.resetPassword.mockResolvedValueOnce({
      data: null,
      error: { status: 400, message: "mystery" },
    });
    await expect(auth.liveResetPassword(input)).resolves.toEqual({
      ok: false,
      outcome: "unavailable",
    });
  });
});

describe("pending next", () => {
  it("is taken once", () => {
    auth.rememberPendingNext(routes.people("acme"));
    expect(auth.takePendingNext()).toBe("/acme");
    expect(auth.takePendingNext()).toBeNull();
  });

  it("survives unavailable storage", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    expect(() => {
      auth.rememberPendingNext(routes.people("acme"));
    }).not.toThrow();
    expect(auth.takePendingNext()).toBeNull();
    spy.mockRestore();
    get.mockRestore();
  });
});

describe("pending email and notice", () => {
  it("each is taken once", () => {
    auth.rememberPendingEmail("marcus@a-intel.example");
    expect(auth.takePendingEmail()).toBe("marcus@a-intel.example");
    expect(auth.takePendingEmail()).toBeNull();
    auth.rememberNotice("passwordSet");
    expect(auth.takeNotice()).toBe("passwordSet");
    expect(auth.takeNotice()).toBeNull();
  });

  it("a stored notice this screen does not know reads as none (negative)", () => {
    sessionStorage.setItem("oxagen.auth.notice", "<script>");
    expect(auth.takeNotice()).toBeNull();
  });

  it("survives unavailable storage", () => {
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    expect(() => {
      auth.rememberPendingEmail("a@b.co");
      auth.rememberNotice("passwordSet");
    }).not.toThrow();
    expect(auth.takePendingEmail()).toBeNull();
    expect(auth.takeNotice()).toBeNull();
    set.mockRestore();
    get.mockRestore();
  });
});

describe("signed-in mark", () => {
  it("is taken once", () => {
    auth.rememberSignedIn();
    expect(auth.takeSignedIn()).toBe(true);
    expect(auth.takeSignedIn()).toBe(false);
  });

  it("anything but the mark this module writes reads as no sign-in (negative)", () => {
    sessionStorage.setItem("oxagen.auth.signedIn", "true");
    expect(auth.takeSignedIn()).toBe(false);
    // Read once all the same: a stray value does not linger for the next page.
    expect(sessionStorage.getItem("oxagen.auth.signedIn")).toBeNull();
  });

  it("survives unavailable storage", () => {
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    expect(() => {
      auth.rememberSignedIn();
    }).not.toThrow();
    expect(auth.takeSignedIn()).toBe(false);
    set.mockRestore();
    get.mockRestore();
  });
});
