import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  emitSecurityEventAsync: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {
    sessions: {
      id: "id",
      userId: "user_id",
      expiresAt: "expires_at",
      ipAddress: "ip_address",
      userAgent: "user_agent",
    },
    securityEvents: {
      id: "id",
      requestId: "request_id",
      eventType: "event_type",
    },
    orgUsers: {
      userId: "user_id",
      orgId: "org_id",
      joinedAt: "joined_at",
    },
  },
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    and: vi.fn((...args: unknown[]) => args),
    gt: vi.fn((...args: unknown[]) => args),
    lt: vi.fn((...args: unknown[]) => args),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
    isNull: vi.fn((arg: unknown) => arg),
    inArray: vi.fn((...args: unknown[]) => args),
  };
});

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

type HandlerFn = (ctx: { step: StepCtx }) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./auth.session-expiry-audit");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

// ── Fake tx builders ──────────────────────────────────────────────────────────
type Session = {
  sessionId: string;
  userId: string;
  expiresAt: Date | string;
  ipAddress: string | null;
  userAgent: string | null;
};

type OrgRow = { userId: string; orgId: string };

function makeSessionTx(sessions: Session[]) {
  const limit = vi.fn().mockResolvedValue(sessions);
  const where = vi.fn().mockReturnValue({ limit });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
}

function makeOrgTx(rows: OrgRow[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select };
}

const NO_ORG_SENTINEL = "00000000-0000-0000-0000-000000000000";

// ─────────────────────────────────────────────────────────────────────────────

describe("authSessionExpiryAudit Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitSecurityEventAsync.mockResolvedValue(undefined);
  });

  it("returns emitted:0 and logs info when no expired sessions found", async () => {
    mocks.withSystemDb.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(makeSessionTx([])),
    );

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ emitted: 0 });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "auth.session-expiry-audit: no unprocessed expired sessions",
    );
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("emits with NO_ORG_SENTINEL when user has no org membership", async () => {
    const sessions: Session[] = [
      {
        sessionId: "sess-1",
        userId: "user-1",
        expiresAt: new Date("2026-06-26"),
        ipAddress: null,
        userAgent: null,
      },
    ];
    mocks.withSystemDb
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeSessionTx(sessions)),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeOrgTx([])),
      );

    await capturedHandler!({ step: makeStep() });

    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: NO_ORG_SENTINEL,
        actorUserId: "user-1",
        requestId: "ttl:sess-1",
        eventType: "auth.sign_out",
        outcome: "success",
      }),
    );
  });

  it("resolves org membership and emits for each session", async () => {
    const sessions: Session[] = [
      {
        sessionId: "sess-a",
        userId: "user-a",
        expiresAt: new Date("2026-06-26"),
        ipAddress: "1.2.3.4",
        userAgent: "Firefox",
      },
      {
        sessionId: "sess-b",
        userId: "user-b",
        expiresAt: new Date("2026-06-25"),
        ipAddress: null,
        userAgent: null,
      },
    ];
    const orgRows: OrgRow[] = [
      { userId: "user-a", orgId: "org-a" },
      { userId: "user-b", orgId: "org-b" },
    ];
    mocks.withSystemDb
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeSessionTx(sessions)),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeOrgTx(orgRows)),
      );

    const result = await capturedHandler!({ step: makeStep() });

    expect(result).toEqual({ emitted: 2 });
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledTimes(2);
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", requestId: "ttl:sess-a" }),
    );
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-b", requestId: "ttl:sess-b" }),
    );
  });

  it("logs a warn when batch cap (BATCH_SIZE=500) is reached", async () => {
    // Create exactly 500 sessions to trigger the batch cap warning
    const sessions: Session[] = Array.from({ length: 500 }, (_, i) => ({
      sessionId: `sess-${i}`,
      userId: `user-${i}`,
      expiresAt: new Date("2026-06-26"),
      ipAddress: null,
      userAgent: null,
    }));
    mocks.withSystemDb
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeSessionTx(sessions)),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeOrgTx([])),
      );

    await capturedHandler!({ step: makeStep() });

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ batchSize: 500 }),
      expect.stringContaining("batch cap"),
    );
  });

  it("parses expiresAt as Date when it arrives as an ISO string (post-Inngest serialization)", async () => {
    const isoString = "2026-06-26T12:00:00.000Z";
    const sessions: Session[] = [
      {
        sessionId: "sess-s",
        userId: "user-s",
        expiresAt: isoString,
        ipAddress: null,
        userAgent: null,
      },
    ];
    mocks.withSystemDb
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeSessionTx(sessions)),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
        fn(makeOrgTx([])),
      );

    await capturedHandler!({ step: makeStep() });

    // emitSecurityEventAsync should receive a real Date, not a string
    const call = mocks.emitSecurityEventAsync.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(call[0].occurredAt).toBeInstanceOf(Date);
    expect((call[0].occurredAt as Date).toISOString()).toBe(isoString);
  });
});
