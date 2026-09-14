// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  signIn: { email: vi.fn() },
  signUp: { email: vi.fn() },
  twoFactor: { verifyTotp: vi.fn(), verifyBackupCode: vi.fn() },
};
vi.mock("@oxagen/auth/client", () => ({ authClient: client }));

const auth = await import("./client-auth");

beforeEach(() => {
  client.signIn.email.mockReset();
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

describe("pending next", () => {
  it("is taken once", () => {
    auth.rememberPendingNext("/acme");
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
      auth.rememberPendingNext("/acme");
    }).not.toThrow();
    expect(auth.takePendingNext()).toBeNull();
    spy.mockRestore();
    get.mockRestore();
  });
});
