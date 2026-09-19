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

/** Ends this session; the caller then sends the browser to the sign-in page. */
export async function liveSignOut(): Promise<void> {
  await (await client()).signOut();
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
export async function liveRegenerateBackupCodes(
  password: string,
): Promise<{ ok: true; codes: string[] } | { ok: false }> {
  const reply = await (await client()).twoFactor.generateBackupCodes({
    password,
  });
  if (reply.error) return { ok: false };
  return { ok: true, codes: reply.data?.backupCodes ?? [] };
}
