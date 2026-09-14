// Form schemas for the sign-in flows. Every issue carries a message *key* under
// `auth.errors.*` (spec §15: no prose in code); the form renders the catalog
// string. The same schema runs in the browser (instant field errors) and in the
// server action (a crafted POST cannot skip it).
import { z } from "zod";

/** Better Auth's own bounds (packages/auth/src/auth.ts minPasswordLength, reset action max). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export type AuthErrorKey =
  | "emailRequired"
  | "emailInvalid"
  | "passwordRequired"
  | "passwordTooShort"
  | "passwordTooLong"
  | "passwordsDiffer"
  | "nameRequired"
  | "nameTooLong"
  | "codeInvalid"
  | "backupCodeInvalid"
  | "tokenMissing";

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
  .max(PASSWORD_MAX, { error: "passwordTooLong" });

export const LoginSchema = z.object({
  email,
  // Sign-in never tells a person their stored password's length rules.
  password: z
    .string()
    .min(1, { error: "passwordRequired" })
    .max(PASSWORD_MAX, { error: "passwordTooLong" }),
  rememberMe: z.boolean().default(true),
});
export type LoginInput = z.input<typeof LoginSchema>;

export const SignupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "nameRequired" })
    .max(120, { error: "nameTooLong" }),
  email,
  password: newPassword,
});
export type SignupInput = z.input<typeof SignupSchema>;

export const TOTP_PATTERN = /^\d{6}$/;

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
export type TwoFactorInput = z.input<typeof TwoFactorSchema>;

export const ForgotPasswordSchema = z.object({ email });
export type ForgotPasswordInput = z.input<typeof ForgotPasswordSchema>;

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
export type ResetPasswordInput = z.input<typeof ResetPasswordSchema>;

/** Field → first error key, for rendering one message under each field. */
export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

export function fieldErrors<K extends string>(
  error: z.ZodError,
): FieldErrors<K> {
  const out: FieldErrors<K> = {};
  for (const issue of error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string") continue;
    const key = field as K;
    out[key] ??= issue.message;
  }
  return out;
}
