// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  signIn: { email: vi.fn(), social: vi.fn(), sso: vi.fn() },
  signUp: { email: vi.fn() },
  twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
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
