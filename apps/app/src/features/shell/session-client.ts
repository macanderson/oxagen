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

/**
 * What a rotation says about itself. `invalid` is the server answering that it
 * refused the password, which it does before it writes anything: nothing
 * rotated. `failed` is every other ending, and it means the outcome is
 * unknown, because Better Auth voids the old set the moment the write lands
 * and keeps only hashes of the new one. A request that left this page without
 * bringing an answer back may have rotated the codes into a set nobody holds.
 */
export type RegenerateResult =
  | { ok: true; codes: string[] }
  | { ok: false; reason: "invalid" | "failed" };

/** Issues a fresh set of two-factor recovery codes; the old set is void. Needs the password. */
export async function liveRegenerateBackupCodes(
  password: string,
): Promise<RegenerateResult> {
  try {
    const reply = await (await client()).twoFactor.generateBackupCodes({
      password,
    });
    if (reply.error) return { ok: false, reason: refusal(reply.error) };
    const codes = reply.data?.backupCodes;
    // A success with no set is the worst of both: the server rotated and this
    // page has nothing to show. It reads as unknown, not as a rotation done.
    if (!Array.isArray(codes) || codes.length === 0)
      return { ok: false, reason: "failed" };
    return { ok: true, codes };
  } catch {
    // Nothing came back, so nothing here knows whether the write landed.
    return { ok: false, reason: "failed" };
  }
}

/**
 * Whether an error answer proves the password was rejected and no rotation
 * happened.
 *
 * Better Auth checks the password and the two-factor row first and answers 4xx
 * from there, so an answered client error is the one failure that proves the
 * stored set is untouched. A 5xx does not: the write may have landed and the
 * response may have died after it. Nor does a transport failure, which
 * better-fetch reports as status 500 with the status text "Fetch Error" rather
 * than by throwing when `catchAllError` is on.
 */
function refusal(error: unknown): "invalid" | "failed" {
  // Read off an unknown shape on purpose: Better Auth types this error as a
  // message alone, and the status it carries at runtime is the only thing that
  // separates an answer from a request that never got one.
  if (!isRecord(error)) return "failed";
  if (error.statusText === "Fetch Error") return "failed";
  const { status } = error;
  if (typeof status !== "number" || status < 400 || status >= 500)
    return "failed";
  return "invalid";
}
