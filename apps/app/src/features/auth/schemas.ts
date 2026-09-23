// Form schemas for the sign-in flows. Every issue carries a message *key* under
// `auth.errors.*` (spec §15: no prose in code); the form renders the catalog
// string. The same schema runs in the browser (instant field errors) and in the
// server action (a crafted POST cannot skip it).
import { z } from "zod";

/**
 * The password policy the sign-up and reset screens list and tick (mockups
 * `obPwBits`): at least 12 characters, one symbol, one digit. Better Auth's own
 * floor (packages/auth/src/auth.ts minPasswordLength) is lower, so a direct API
 * call still meets only that floor until the server enforces the same policy.
 */
export const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const HAS_SYMBOL = /[^A-Za-z0-9]/;
const HAS_DIGIT = /[0-9]/;

/** The three requirements in the order the screens list them, each true once the value meets it. */
export function passwordRequirements(value: string): {
  length: boolean;
  symbol: boolean;
  digit: boolean;
} {
  return {
    length: value.length >= PASSWORD_MIN,
    symbol: HAS_SYMBOL.test(value),
    digit: HAS_DIGIT.test(value),
  };
}

/** How many of the meter's four segments are lit: one per four characters (mockups `obPwBits`). */
export function passwordMeterScore(value: string): number {
  return Math.min(4, Math.floor(value.length / 4));
}

/** The catalog keys under `auth.errors.*` a schema issue may carry. */
const AUTH_ERROR_KEYS = [
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
] as const;
export type AuthErrorKey = (typeof AUTH_ERROR_KEYS)[number];

const email = z
  .string()
  .trim()
  .min(1, { error: "emailRequired" })
  .max(254, { error: "emailInvalid" })
  .pipe(z.email({ error: "emailInvalid" }));

const newPassword = z
  .string()
  .min(1, { error: "passwordRequired" })
  .min(PASSWORD_MIN, { error: "passwordTooShort" })
  .max(PASSWORD_MAX, { error: "passwordTooLong" })
  .regex(HAS_SYMBOL, { error: "passwordNeedsSymbol" })
  .regex(HAS_DIGIT, { error: "passwordNeedsDigit" });

export const LoginSchema = z.object({
  email,
  // Sign-in never tells a person their stored password's length rules.
  password: z
    .string()
    .min(1, { error: "passwordRequired" })
    .max(PASSWORD_MAX, { error: "passwordTooLong" }),
  rememberMe: z.boolean().default(true),
});

export const SignupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "nameRequired" })
    .max(120, { error: "nameTooLong" }),
  email,
  password: newPassword,
});

const TOTP_PATTERN = /^\d{6}$/;

export const TwoFactorSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("totp"),
    code: z.string().trim().regex(TOTP_PATTERN, { error: "codeInvalid" }),
  }),
  z.object({
    method: z.literal("backup"),
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{6,32}$/, { error: "backupCodeInvalid" }),
  }),
]);

export const ForgotPasswordSchema = z.object({ email });

/** Enterprise SSO: the email's domain names the identity provider. */
export const SsoSignInSchema = z.object({ email });

export const ResendVerificationSchema = z.object({ email });

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1, { error: "tokenMissing" }),
    newPassword,
    confirmPassword: z.string().min(1, { error: "passwordRequired" }),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    error: "passwordsDiffer",
  });

/** Field → first error key, for rendering one message under each field. */
export type FieldErrors<K extends string = string> = Partial<
  Record<K, AuthErrorKey>
>;

/** Each field's first error as a catalog key; an issue outside the catalog keys is dropped. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    const key = AUTH_ERROR_KEYS.find((k) => k === issue.message);
    if (typeof field !== "string" || key === undefined) continue;
    out[field] ??= key;
  }
  return out;
}
