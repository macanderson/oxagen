// Browser-side Better Auth calls, behind one seam so forms stay testable and so
// the Better Auth client (and its env reader) loads only when a live call runs.
import { type AuthOutcomeKey, authOutcomeKey } from "./auth-errors";

export type ClientAuthResult =
  | { ok: true; twoFactor?: boolean; needsVerification?: boolean }
  | { ok: false; outcome: AuthOutcomeKey };

type BetterAuthReply = {
  data?: unknown;
  error?: { code?: string; status?: number; message?: string } | null;
};

/** Where a sign-in that stopped for a second factor resumes. Read by the two-factor form. */
export const PENDING_NEXT_KEY = "oxagen.auth.next";

async function client() {
  const { authClient } = await import("@oxagen/auth/client");
  return authClient;
}

function fail(reply: BetterAuthReply): ClientAuthResult | null {
  return reply.error
    ? { ok: false, outcome: authOutcomeKey(reply.error) }
    : null;
}

export async function liveSignIn(input: {
  email: string;
  password: string;
  rememberMe: boolean;
}): Promise<ClientAuthResult> {
  const reply = (await (await client()).signIn.email(input)) as BetterAuthReply;
  const failed = fail(reply);
  if (failed) return failed;
  const data = reply.data as { twoFactorRedirect?: boolean } | null | undefined;
  return { ok: true, twoFactor: data?.twoFactorRedirect === true };
}

export async function liveSignUp(input: {
  name: string;
  email: string;
  password: string;
}): Promise<ClientAuthResult> {
  const reply = (await (await client()).signUp.email(input)) as BetterAuthReply;
  const failed = fail(reply);
  if (failed) return failed;
  // With email verification required Better Auth creates the user but issues no session token.
  const data = reply.data as { token?: string | null } | null | undefined;
  return { ok: true, needsVerification: !data?.token };
}

export async function liveVerifyTwoFactor(input: {
  method: "totp" | "backup";
  code: string;
}): Promise<ClientAuthResult> {
  const c = await client();
  const reply = (
    input.method === "totp"
      ? await c.twoFactor.verifyTotp({ code: input.code })
      : await c.twoFactor.verifyBackupCode({ code: input.code })
  ) as BetterAuthReply;
  return fail(reply) ?? { ok: true };
}

export function rememberPendingNext(next: string): void {
  try {
    sessionStorage.setItem(PENDING_NEXT_KEY, next);
  } catch {
    // Storage can be unavailable (private mode); the two-factor page then lands on "/".
  }
}

export function takePendingNext(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_NEXT_KEY);
    sessionStorage.removeItem(PENDING_NEXT_KEY);
    return value;
  } catch {
    return null;
  }
}
