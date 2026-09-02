import { Hono } from "hono";
import { isEmailVerificationRequired } from "@oxagen/auth";
import { isEmailTransportConfigured } from "@oxagen/notifications";
import type { AppEnv } from "../app";

/**
 * Liveness + lightweight readiness probe.
 *
 * Vercel / uptime monitors hit this endpoint. The shape is intentionally small:
 *   { status: "ok" | "degraded", checks: { <name>: "ok" | "fail" } }
 *
 * **Email-transport gate (OXA-1753).** Deployed environments set Better Auth's
 * `requireEmailVerification` to true (see packages/auth/src/auth.ts), which
 * means every credential sign-up needs the verification email delivered. That
 * email goes through `@oxagen/notifications` → SMTP_*. If SMTP_* is missing on
 * a deployed env, the send is fire-and-forget and silently fails — so no one
 * can complete sign-in. We surface that configuration error here as a 503 so
 * deploy probes catch it instead of customers.
 *
 * Why not throw at auth module-load? OAuth sign-in (Google/GitHub) doesn't need
 * email — it returns pre-verified addresses — and throwing would break OAuth
 * along with credential sign-up. The ticket explicitly calls this out.
 */
export const health = new Hono<AppEnv>();

type CheckResult = "ok" | "fail";

function evaluateChecks(): {
  allOk: boolean;
  checks: Record<string, CheckResult>;
} {
  const checks: Record<string, CheckResult> = {};

  if (isEmailVerificationRequired()) {
    checks.email_transport = isEmailTransportConfigured() ? "ok" : "fail";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");
  return { allOk, checks };
}

health.get("/", (c) => {
  const { allOk, checks } = evaluateChecks();
  if (allOk) {
    return c.json({ status: "ok" as const, checks });
  }
  return c.json({ status: "degraded" as const, checks }, 503);
});
