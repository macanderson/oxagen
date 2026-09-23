import { describe, expect, it } from "vitest";
import { z } from "zod";
import authMessages from "../../../messages/auth.json";
import {
  ForgotPasswordSchema,
  LoginSchema,
  ResetPasswordSchema,
  SignupSchema,
  TwoFactorSchema,
  fieldErrors,
  passwordMeterScore,
  passwordRequirements,
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
  it("requires a name and a password of at least twelve characters", () => {
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

  it.each([
    ["missioncontrol9", "passwordNeedsSymbol"],
    ["mission-control", "passwordNeedsDigit"],
  ])("refuses %s: the password needs a symbol and a digit", (password, key) => {
    expect(
      errorsOf(
        SignupSchema.safeParse({ name: "M", email: "a@b.co", password }),
      ),
    ).toEqual({ password: key });
  });

  it("accepts a password that meets all three requirements", () => {
    expect(
      SignupSchema.safeParse({
        name: "M",
        email: "a@b.co",
        password: "mission-control-9",
      }).success,
    ).toBe(true);
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
          newPassword: "Rq7!mesa-lattice",
          confirmPassword: "Rq7!mesa-lattice",
        }),
      ),
    ).toEqual({ token: "tokenMissing" });
  });
});

describe("password requirements and meter", () => {
  it("ticks each requirement on its own", () => {
    expect(passwordRequirements("")).toEqual({
      length: false,
      symbol: false,
      digit: false,
    });
    expect(passwordRequirements("abc!")).toEqual({
      length: false,
      symbol: true,
      digit: false,
    });
    expect(passwordRequirements("abcdefghijk7")).toEqual({
      length: true,
      symbol: false,
      digit: true,
    });
  });

  it("lights one of four segments per four characters", () => {
    expect(passwordMeterScore("")).toBe(0);
    expect(passwordMeterScore("abc")).toBe(0);
    expect(passwordMeterScore("abcd")).toBe(1);
    expect(passwordMeterScore("a".repeat(15))).toBe(3);
    expect(passwordMeterScore("a".repeat(40))).toBe(4);
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
      "passwordNeedsSymbol",
      "passwordNeedsDigit",
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

  it("drops an issue whose message is not a catalog key (negative)", () => {
    const result = z
      .object({ email: z.string(), name: z.string() })
      .safeParse({ email: 1, name: 2 });
    expect(errorsOf(result)).toEqual({});
    const keyed = z
      .object({ email: z.string({ error: "emailInvalid" }) })
      .safeParse({ email: 1 });
    expect(errorsOf(keyed)).toEqual({ email: "emailInvalid" });
  });
});
