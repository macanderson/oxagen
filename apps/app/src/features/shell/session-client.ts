// The shell's browser-side Better Auth calls (ARCHITECTURE.md §3.8): sign out
// from the user menu, and the Security tab's session list, session revoke,
// and fresh recovery codes. Behind one seam, as features/auth/auth-client.ts
// is for the sign-in flows, so the Better Auth client (and its env reader)
// loads only when a live call runs and the dialog stays testable over a fake.
//
// The auth barrel is server-only and a lane may not import another lane's
// internals, so the shell keeps this seam of its own rather than reaching
// into features/auth.

async function client() {
  const { authClient } = await import("@oxagen/auth/client");
  return authClient;
}

/**
 * Ends this session, and says whether it ended.
 *
 * Better Auth reports a refused call by resolving with `error` set rather than
 * rejecting, so awaiting the promise says nothing: a sign-out that never
 * reached the server, or that the server refused, looked exactly like one that
 * worked. The caller then sent the browser to the sign-in page with the
 * session cookie still valid, which is the worst way to get this wrong. Sign
 * out is what a person reaches for when they do not trust the machine they are
 * on, and Back would have put them straight back into the app as themselves.
 *
 * The other calls in this seam already read `error`; this one now does too.
 */
export async function liveSignOut(): Promise<boolean> {
  const reply = await (await client()).signOut();
  return !reply.error;
}

/** One of the person's sessions as the Security tab lists it. */
export type LiveSession = {
  /** Opaque, and what `revokeSession` takes; never shown. */
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  updatedAt: Date;
  /** True for the session making this request. */
  current: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function when(value: unknown): Date {
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(at.getTime()) ? new Date(0) : at;
}

/** Every session that can act as this person, the current one first. */
export async function liveListSessions(): Promise<
  { ok: true; sessions: LiveSession[] } | { ok: false }
> {
  const c = await client();
  const [me, list] = await Promise.all([c.getSession(), c.listSessions()]);
  if (list.error || !Array.isArray(list.data)) return { ok: false };
  // The current session's token is not decoration: it is what marks one row
  // "this device" and takes its Revoke button away. `getSession()` returns a
  // refusal as an error RESULT rather than by throwing, so reading
  // `me.data?.session.token` alone turned a failed read into `null`, and a
  // null token matches no row. Every session then rendered as another device
  // with a Revoke button, including the one holding the page open: a person
  // tidying up their sessions could sign themselves out through a control
  // that does not mean that, with none of the sign-out path's handling.
  //
  // So a list that cannot say which session is the caller's is not a list
  // worth rendering. The tab already has a failure state and shows it.
  const currentToken = me.error ? null : text(me.data?.session.token);
  if (currentToken === null) return { ok: false };
  const rows: unknown[] = list.data;
  const sessions: LiveSession[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const token = text(row.token);
    if (token === null) continue;
    sessions.push({
      token,
      userAgent: text(row.userAgent),
      ipAddress: text(row.ipAddress),
      updatedAt: when(row.updatedAt),
      current: token === currentToken,
    });
  }
  sessions.sort((a, b) => Number(b.current) - Number(a.current));
  return { ok: true, sessions };
}

/** Ends one other session; it stops at its next request. */
export async function liveRevokeSession(token: string): Promise<boolean> {
  const reply = await (await client()).revokeSession({ token });
  return !reply.error;
}

/** Issues a fresh set of two-factor recovery codes; the old set is void. Needs the password. */
/**
 * Rotates the recovery codes, and says whether a failure is one we can explain.
 *
 * `refused` separates two outcomes a single `ok: false` used to collapse. A
 * 400, 401 or 403 is the server declining the password: it read the request and
 * said no, so nothing was rotated and the stored set still works. Anything
 * else, a 5xx or a call that never came back, says nothing about what the
 * server did. Better Auth voids the old codes as soon as it commits, so an
 * unexplained failure may well have committed and lost only the response, in
 * which case the old set is already dead and the new one is gone.
 *
 * Reporting that as "the password was not accepted" is the dangerous reading:
 * it tells the person nothing happened, so they carry on with codes that no
 * longer work and find out when the authenticator is gone.
 */
export async function liveRegenerateBackupCodes(
  password: string,
): Promise<{ ok: true; codes: string[] } | { ok: false; refused: boolean }> {
  try {
    const reply = await (await client()).twoFactor.generateBackupCodes({
      password,
    });
    if (reply.error) {
      // Read defensively rather than asserted, and through `unknown`: the
      // client types the error loosely, and an unreadable status is an unknown
      // outcome, not a refusal, which is the direction that fails safe.
      const failure: unknown = reply.error;
      const refused =
        isRecord(failure) &&
        (failure.status === 400 ||
          failure.status === 401 ||
          failure.status === 403);
      return { ok: false, refused };
    }
    return { ok: true, codes: reply.data?.backupCodes ?? [] };
  } catch {
    // Never reached the server, or never came back from it. Either way the
    // outcome is unknown, which is not the same as refused.
    return { ok: false, refused: false };
  }
}
