import { describe, expect, it } from "vitest";
import authMessages from "../../../messages/auth.json";
import {
  ForgotPasswordSchema,
  LoginSchema,
  ResetPasswordSchema,
  SignupSchema,
  TwoFactorSchema,
  fieldErrors,
} from "./schemas";

function errorsOf(result: {
  success: boolean;
  error?: import("zod").ZodError;
}) {
  if (result.success || !result.error) return {};
  return fieldErrors(result.error);
}

describe("LoginSchema", () => {
  it("accepts an email and password, trimming the email", () => {
    const r = LoginSchema.safeParse({
      email: "  marcus.bell@acme.example ",
      password: "x",
    });
    expect(r.success).toBe(true);
    expect(r.data?.email).toBe("marcus.bell@acme.example");
    expect(r.data?.rememberMe).toBe(true);
  });

  it("names a missing and a malformed email", () => {
    expect(
      errorsOf(LoginSchema.safeParse({ email: "", password: "" })),
    ).toEqual({
      email: "emailRequired",
      password: "passwordRequired",
    });
    expect(
      errorsOf(LoginSchema.safeParse({ email: "not-an-email", password: "x" })),
    ).toEqual({
      email: "emailInvalid",
    });
  });
});

describe("SignupSchema", () => {
  it("requires a name and a password of at least eight characters", () => {
    expect(
      errorsOf(
        SignupSchema.safeParse({
          name: " ",
          email: "a@b.co",
          password: "short",
        }),
      ),
    ).toEqual({
      name: "nameRequired",
      password: "passwordTooShort",
    });
  });

  it("refuses a password longer than Better Auth accepts", () => {
    expect(
      errorsOf(
        SignupSchema.safeParse({
          name: "M",
          email: "a@b.co",
          password: "a".repeat(129),
        }),
      ),
    ).toEqual({
      password: "passwordTooLong",
    });
  });
});

describe("TwoFactorSchema", () => {
  it("accepts a six-digit authenticator code", () => {
    expect(
      TwoFactorSchema.safeParse({ method: "totp", code: " 602914 " }).success,
    ).toBe(true);
  });

  it("refuses a code that is not six digits", () => {
    expect(
      errorsOf(TwoFactorSchema.safeParse({ method: "totp", code: "60291" })),
    ).toEqual({ code: "codeInvalid" });
    expect(
      errorsOf(TwoFactorSchema.safeParse({ method: "totp", code: "abcdef" })),
    ).toEqual({ code: "codeInvalid" });
  });

  it("validates a recovery code by its own shape", () => {
    expect(
      TwoFactorSchema.safeParse({ method: "backup", code: "AbCd3-fGh1j" })
        .success,
    ).toBe(true);
    expect(
      errorsOf(TwoFactorSchema.safeParse({ method: "backup", code: "no" })),
    ).toEqual({
      code: "backupCodeInvalid",
    });
  });
});

describe("ResetPasswordSchema", () => {
  it("refuses two passwords that differ, on the confirmation field", () => {
    expect(
      errorsOf(
        ResetPasswordSchema.safeParse({
          token: "t",
          newPassword: "Rq7!mesa-lattice",
          confirmPassword: "Rq7!mesa-latice",
        }),
      ),
    ).toEqual({ confirmPassword: "passwordsDiffer" });
  });

  it("refuses a missing token", () => {
    expect(
      errorsOf(
        ResetPasswordSchema.safeParse({
          token: "",
          newPassword: "longenough",
          confirmPassword: "longenough",
        }),
      ),
    ).toEqual({ token: "tokenMissing" });
  });
});

describe("ForgotPasswordSchema", () => {
  it("requires an email", () => {
    expect(errorsOf(ForgotPasswordSchema.safeParse({ email: "" }))).toEqual({
      email: "emailRequired",
    });
  });
});

describe("error keys", () => {
  it("every key a schema can emit has catalog copy", () => {
    const keys = [
      "emailRequired",
      "emailInvalid",
      "passwordRequired",
      "passwordTooShort",
      "passwordTooLong",
      "passwordsDiffer",
      "nameRequired",
      "nameTooLong",
      "codeInvalid",
      "backupCodeInvalid",
      "tokenMissing",
    ];
    for (const key of keys)
      expect(authMessages.auth.errors).toHaveProperty(key);
  });
});
