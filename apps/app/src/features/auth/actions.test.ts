import { beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
};
vi.mock("@oxagen/auth/server", () => ({ auth: { api } }));
const warn = vi.fn();
vi.mock("@oxagen/handlers/logger", () => ({ logger: { warn } }));

const actions = await import("./actions");

beforeEach(() => {
  warn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("requestPasswordReset", () => {
  it("asks Better Auth for a reset link to /reset-password", async () => {
    api.requestPasswordReset.mockResolvedValue({ status: true });
    await expect(
      actions.requestPasswordReset({ email: "m@acme.example" }),
    ).resolves.toEqual({ ok: true, to: "/forgot-password" });
    expect(api.requestPasswordReset).toHaveBeenCalledWith({
      body: { email: "m@acme.example", redirectTo: "/reset-password" },
    });
  });

  it("answers ok even when sending fails, and logs it without the address", async () => {
    api.requestPasswordReset.mockRejectedValue(new Error("smtp down"));
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
    expect(api.resetPassword).not.toHaveBeenCalled();
  });
});

describe("resendVerification", () => {
  it("sends a verification email that returns to a sanitised destination", async () => {
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
      body: { email: "m@acme.example", callbackURL: "/new-organization" },
    });
  });

  it("answers ok when sending fails, and validates (negative)", async () => {
    api.sendVerificationEmail.mockRejectedValue(new Error("smtp"));
    expect(
      await actions.resendVerification({ email: "m@acme.example" }),
    ).toEqual({ ok: true, to: "/verify" });
    expect(warn).toHaveBeenCalledOnce();
    expect(await actions.resendVerification({ email: "" })).toEqual({
      ok: false,
      fields: { email: "emailRequired" },
    });
    expect(api.sendVerificationEmail).toHaveBeenCalledOnce();
  });
});
