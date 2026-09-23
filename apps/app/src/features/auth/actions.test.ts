import { beforeEach, describe, expect, it, vi } from "vitest";

const session = {
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
};
vi.mock("@/server/session", () => session);
const warn = vi.fn();
vi.mock("@oxagen/telemetry", () => ({ captureError: warn }));

const actions = await import("./actions");

beforeEach(() => {
  warn.mockReset();
  for (const fn of Object.values(session)) fn.mockReset();
});

describe("requestPasswordReset", () => {
  it("asks Better Auth for a reset link to /reset-password", async () => {
    session.requestPasswordReset.mockResolvedValue(undefined);
    await expect(
      actions.requestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true, to: "/forgot-password" });
    expect(session.requestPasswordReset).toHaveBeenCalledWith({
      email: "m@acme.example",
      redirectTo: "/reset-password",
    });
  });

  it("answers ok even when sending fails, and logs it without the address", async () => {
    session.requestPasswordReset.mockRejectedValue(new Error("smtp down"));
    await expect(
      actions.requestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true, to: "/forgot-password" });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("m@acme.example");
  });

  it("validates before calling Better Auth (negative)", async () => {
    expect(await actions.requestPasswordReset({ email: "nope" })).toEqual({
      ok: false,
      fields: { email: "emailInvalid" },
    });
    expect(session.requestPasswordReset).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  const good = {
    token: "rst_live",
    newPassword: "Rq7!mesa-lattice",
    confirmPassword: "Rq7!mesa-lattice",
  };

  it("sets the password through Better Auth", async () => {
    session.resetPassword.mockResolvedValue(undefined);
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: true,
      to: "/login",
    });
    expect(session.resetPassword).toHaveBeenCalledWith({
      token: "rst_live",
      newPassword: "Rq7!mesa-lattice",
    });
  });

  it("maps a spent token to linkExpired without logging, an unknown failure to unavailable, and logs every failure but the spent token", async () => {
    session.resetPassword.mockRejectedValueOnce({
      body: { code: "INVALID_TOKEN" },
    });
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: false,
      outcome: "linkExpired",
    });
    expect(warn).not.toHaveBeenCalled();
    session.resetPassword.mockRejectedValueOnce({ status: 503 });
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: false,
      outcome: "unavailable",
    });
    session.resetPassword.mockRejectedValueOnce(new Error("mystery"));
    await expect(actions.resetPassword(good)).resolves.toEqual({
      ok: false,
      outcome: "unavailable",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Rq7!mesa-lattice");
  });

  it("validates: a missing token is an expired link, a mismatch is a field error (negative)", async () => {
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
    expect(session.resetPassword).not.toHaveBeenCalled();
  });
});

describe("resendVerification", () => {
  it("sends a verification email that returns to a sanitised destination", async () => {
    session.sendVerificationEmail.mockResolvedValue(undefined);
    await expect(
      actions.resendVerification({
        email: "m@acme.example",
        next: "//evil.example",
      }),
    ).resolves.toEqual({
      ok: true,
      to: "/verify",
    });
    expect(session.sendVerificationEmail).toHaveBeenCalledWith({
      email: "m@acme.example",
      callbackURL: "/new-organization",
    });
    await actions.resendVerification({
      email: "m@acme.example",
      next: "/acme/core",
    });
    expect(session.sendVerificationEmail).toHaveBeenLastCalledWith({
      email: "m@acme.example",
      callbackURL: "/acme/core",
    });
  });

  it("answers ok when sending fails, and validates (negative)", async () => {
    session.sendVerificationEmail.mockRejectedValue(new Error("smtp"));
    expect(
      await actions.resendVerification({ email: "m@acme.example" }),
    ).toEqual({ ok: true, to: "/verify" });
    expect(warn).toHaveBeenCalledOnce();
    expect(await actions.resendVerification({ email: "" })).toEqual({
      ok: false,
      fields: { email: "emailRequired" },
    });
    expect(session.sendVerificationEmail).toHaveBeenCalledOnce();
  });
});
