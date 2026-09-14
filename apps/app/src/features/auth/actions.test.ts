import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
  FIXTURE_USER,
} from "@/server/fixture-session";

const setCookie = vi.fn();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: setCookie }),
}));

const api = {
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
};
vi.mock("@oxagen/auth/server", () => ({ auth: { api } }));
const warn = vi.fn();
vi.mock("@oxagen/handlers/logger", () => ({ logger: { warn } }));

const actions = await import("./actions");

function fixtureMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "fixture");
}
function liveMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "live");
}

beforeEach(() => {
  setCookie.mockReset();
  warn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("signInFixture", () => {
  it("signs in the fixture operator and returns the sanitised destination", async () => {
    fixtureMode();
    await expect(
      actions.signInFixture({
        email: FIXTURE_USER.email,
        password: "mission-control",
        next: "/acme/core-platform",
      }),
    ).resolves.toEqual({ ok: true, to: "/acme/core-platform" });
    expect(setCookie).toHaveBeenCalledWith(
      FIXTURE_SESSION_COOKIE,
      FIXTURE_SESSION_VALUE,
      expect.objectContaining({ httpOnly: true, path: "/" }),
    );
  });

  it("never returns a protocol-relative destination", async () => {
    fixtureMode();
    await expect(
      actions.signInFixture({
        email: FIXTURE_USER.email,
        password: "mission-control",
        next: "//evil.example",
      }),
    ).resolves.toEqual({ ok: true, to: "/" });
  });

  it("refuses wrong credentials without a cookie", async () => {
    fixtureMode();
    await expect(
      actions.signInFixture({ email: FIXTURE_USER.email, password: "nope" }),
    ).resolves.toEqual({
      ok: false,
      outcome: "wrongCredentials",
    });
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("re-validates the input", async () => {
    fixtureMode();
    const result = await actions.signInFixture({ email: "bad", password: "" });
    expect(result).toEqual({
      ok: false,
      fields: { email: "emailInvalid", password: "passwordRequired" },
    });
  });

  it("refuses outside fixture mode", async () => {
    liveMode();
    await expect(
      actions.signInFixture({
        email: FIXTURE_USER.email,
        password: "mission-control",
      }),
    ).resolves.toEqual({
      ok: false,
      outcome: "unavailable",
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    await expect(
      actions.signInFixture({
        email: FIXTURE_USER.email,
        password: "mission-control",
      }),
    ).resolves.toEqual({
      ok: false,
      outcome: "unavailable",
    });
    expect(setCookie).not.toHaveBeenCalled();
  });
});

describe("signUpFixture", () => {
  it("creates the fixture session and enters the gate, or the invitation it came from", async () => {
    fixtureMode();
    const input = {
      name: "Marcus",
      email: "m@acme.example",
      password: "mission-control",
    };
    await expect(actions.signUpFixture(input)).resolves.toEqual({
      ok: true,
      to: "/welcome",
    });
    await expect(
      actions.signUpFixture({ ...input, next: "/invite/invi_1" }),
    ).resolves.toEqual({ ok: true, to: "/invite/invi_1" });
  });

  it("validates and refuses outside fixture mode", async () => {
    fixtureMode();
    expect(
      await actions.signUpFixture({
        name: "",
        email: "m@acme.example",
        password: "short",
      }),
    ).toEqual({
      ok: false,
      fields: { name: "nameRequired", password: "passwordTooShort" },
    });
    liveMode();
    expect(
      await actions.signUpFixture({
        name: "M",
        email: "m@acme.example",
        password: "mission-control",
      }),
    ).toEqual({
      ok: false,
      outcome: "unavailable",
    });
  });
});

describe("verifyTwoFactorFixture", () => {
  it("accepts only the fixture authenticator code", async () => {
    fixtureMode();
    await expect(
      actions.verifyTwoFactorFixture({
        method: "totp",
        code: "602914",
        next: "/acme",
      }),
    ).resolves.toEqual({
      ok: true,
      to: "/acme",
    });
    await expect(
      actions.verifyTwoFactorFixture({ method: "totp", code: "000000" }),
    ).resolves.toEqual({
      ok: false,
      outcome: "codeWrong",
    });
    await expect(
      actions.verifyTwoFactorFixture({ method: "backup", code: "AbCd3-fGh1j" }),
    ).resolves.toEqual({
      ok: false,
      outcome: "codeWrong",
    });
    expect(
      await actions.verifyTwoFactorFixture({ method: "totp", code: "12" }),
    ).toEqual({
      ok: false,
      fields: { code: "codeInvalid" },
    });
  });

  it("refuses outside fixture mode", async () => {
    liveMode();
    expect(
      await actions.verifyTwoFactorFixture({ method: "totp", code: "602914" }),
    ).toEqual({ ok: false, outcome: "unavailable" });
  });
});

describe("requestPasswordReset", () => {
  it("asks Better Auth for a reset link to /reset-password", async () => {
    liveMode();
    api.requestPasswordReset.mockResolvedValue({ status: true });
    await expect(
      actions.requestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true, to: "/forgot-password" });
    expect(api.requestPasswordReset).toHaveBeenCalledWith({
      body: { email: "m@acme.example", redirectTo: "/reset-password" },
    });
  });

  it("answers ok even when sending fails, and logs it without the address", async () => {
    liveMode();
    api.requestPasswordReset.mockRejectedValue(new Error("smtp down"));
    await expect(
      actions.requestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true, to: "/forgot-password" });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("m@acme.example");
  });

  it("validates, and never calls Better Auth in fixture mode", async () => {
    fixtureMode();
    expect(await actions.requestPasswordReset({ email: "nope" })).toEqual({
      ok: false,
      fields: { email: "emailInvalid" },
    });
    expect(
      await actions.requestPasswordReset({ email: "m@acme.example" }),
    ).toEqual({ ok: true, to: "/forgot-password" });
    expect(api.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  const good = {
    token: "rst_live",
    newPassword: "Rq7!mesa-lattice",
    confirmPassword: "Rq7!mesa-lattice",
  };

  it("sets the password through Better Auth", async () => {
    liveMode();
    api.resetPassword.mockResolvedValue({ status: true });
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: true,
      to: "/login",
    });
    expect(api.resetPassword).toHaveBeenCalledWith({
      body: { token: "rst_live", newPassword: "Rq7!mesa-lattice" },
    });
  });

  it("maps a spent token to linkExpired without logging, and anything else to its outcome with a log", async () => {
    liveMode();
    api.resetPassword.mockRejectedValueOnce({
      body: { code: "INVALID_TOKEN" },
    });
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: false,
      outcome: "linkExpired",
    });
    expect(warn).not.toHaveBeenCalled();
    api.resetPassword.mockRejectedValueOnce({ status: 503 });
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: false,
      outcome: "unavailable",
    });
    api.resetPassword.mockRejectedValueOnce(new Error("mystery"));
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: false,
      outcome: "linkExpired",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Rq7!mesa-lattice");
  });

  it("validates: a missing token is an expired link, a mismatch is a field error", async () => {
    fixtureMode();
    expect(await actions.resetPassword({ ...good, token: "" })).toEqual({
      ok: false,
      outcome: "linkExpired",
    });
    expect(
      await actions.resetPassword({ ...good, confirmPassword: "different" }),
    ).toEqual({
      ok: false,
      fields: { confirmPassword: "passwordsDiffer" },
    });
  });

  it("fixture · only the fixture token works", async () => {
    fixtureMode();
    expect(
      await actions.resetPassword({ ...good, token: "rst_fixture_01" }),
    ).toEqual({ ok: true, to: "/login" });
    expect(await actions.resetPassword(good)).toEqual({
      ok: false,
      outcome: "linkExpired",
    });
  });
});

describe("resendVerification", () => {
  it("sends a verification email that returns to a sanitised destination", async () => {
    liveMode();
    api.sendVerificationEmail.mockResolvedValue({ status: true });
    await expect(
      actions.resendVerification({
        email: "m@acme.example",
        next: "//evil.example",
      }),
    ).resolves.toEqual({
      ok: true,
      to: "/verify",
    });
    expect(api.sendVerificationEmail).toHaveBeenCalledWith({
      body: { email: "m@acme.example", callbackURL: "/welcome" },
    });
  });

  it("answers ok when sending fails, validates, and skips Better Auth in fixture mode", async () => {
    liveMode();
    api.sendVerificationEmail.mockRejectedValue(new Error("smtp"));
    expect(
      await actions.resendVerification({ email: "m@acme.example" }),
    ).toEqual({ ok: true, to: "/verify" });
    expect(warn).toHaveBeenCalledOnce();
    expect(await actions.resendVerification({ email: "" })).toEqual({
      ok: false,
      fields: { email: "emailRequired" },
    });
    fixtureMode();
    api.sendVerificationEmail.mockClear();
    expect(
      await actions.resendVerification({ email: "m@acme.example" }),
    ).toEqual({ ok: true, to: "/verify" });
    expect(api.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
