// The Security tab's session list, over a fake Better Auth client.
//
// The case that earns this file is the first one in "the current session":
// Better Auth returns a refusal as an error RESULT rather than by throwing, so
// a read of `me.data?.session.token` that ignores `me.error` turns a failed
// read into `null`. A null token matches no row, every session renders as
// another device with a Revoke button, and the person can sign themselves out
// through a control that does not say that.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const listSessions = vi.fn();
const revokeSession = vi.fn();
vi.mock("@oxagen/auth/client", () => ({
  authClient: { getSession, listSessions, revokeSession },
}));

const { liveListSessions, liveRevokeSession } = await import(
  "./session-client"
);

const HERE = "tok-here";
const PHONE = "tok-phone";

function row(token: string) {
  return {
    token,
    userAgent: "Mozilla/5.0",
    ipAddress: "73.15.240.8",
    updatedAt: new Date("2026-09-18T15:47:00Z"),
  };
}

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue({ data: { session: { token: HERE } } });
  listSessions.mockReset();
  listSessions.mockResolvedValue({ data: [row(PHONE), row(HERE)] });
  revokeSession.mockReset();
  revokeSession.mockResolvedValue({});
});

describe("the current session", () => {
  it("marks it, and puts it first", async () => {
    const answer = await liveListSessions();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.sessions.map((s) => [s.token, s.current])).toEqual([
      [HERE, true],
      [PHONE, false],
    ]);
  });

  // The whole list is refused rather than rendered with no current session,
  // because the alternative is a Revoke button on the session holding the
  // page open. The tab already has a failure state and shows it.
  it("refuses the list when the current-session read errors (negative)", async () => {
    getSession.mockResolvedValue({ error: { message: "unauthorized" } });
    expect(await liveListSessions()).toEqual({ ok: false });
  });

  it("refuses the list when the read answers no session (negative)", async () => {
    getSession.mockResolvedValue({ data: null });
    expect(await liveListSessions()).toEqual({ ok: false });
  });

  it("refuses the list when the token is not a string (negative)", async () => {
    getSession.mockResolvedValue({ data: { session: { token: "" } } });
    expect(await liveListSessions()).toEqual({ ok: false });
  });
});

describe("the list itself", () => {
  it("refuses when the list read errors (negative)", async () => {
    listSessions.mockResolvedValue({ error: { message: "down" } });
    expect(await liveListSessions()).toEqual({ ok: false });
  });

  it("refuses when the answer is not an array (negative)", async () => {
    listSessions.mockResolvedValue({ data: { sessions: [] } });
    expect(await liveListSessions()).toEqual({ ok: false });
  });

  // A row with no token cannot be revoked and cannot be matched against the
  // current one, so it is dropped rather than rendered as an unactionable line.
  it("drops a row with no token", async () => {
    listSessions.mockResolvedValue({ data: [row(HERE), { userAgent: "x" }] });
    const answer = await liveListSessions();
    expect(answer.ok && answer.sessions).toHaveLength(1);
  });

  it("reads an unparseable timestamp as the epoch rather than NaN", async () => {
    listSessions.mockResolvedValue({
      data: [{ ...row(HERE), updatedAt: "not a date" }],
    });
    const answer = await liveListSessions();
    expect(answer.ok && answer.sessions[0]?.updatedAt).toEqual(new Date(0));
  });
});

describe("revoking", () => {
  it("reports success when Better Auth raises no error", async () => {
    expect(await liveRevokeSession(PHONE)).toBe(true);
    expect(revokeSession).toHaveBeenCalledWith({ token: PHONE });
  });

  it("reports failure on an error result (negative)", async () => {
    revokeSession.mockResolvedValue({ error: { message: "nope" } });
    expect(await liveRevokeSession(PHONE)).toBe(false);
  });
});
