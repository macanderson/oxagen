import { describe, expect, it, vi, beforeEach } from "vitest";
import { NonRetriableError } from "inngest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateSet: vi.fn(),
  deleteFrom: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

// Drizzle tx mock:
//   tx.update(table).set(payload).where(cond) — records every set().
//   tx.delete(table).where(cond)              — records every delete target.
function makeTx() {
  return {
    update: (table: unknown) => ({
      set: (payload: unknown) => {
        mocks.updateSet({ table, payload });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    delete: (table: unknown) => {
      mocks.deleteFrom({ table });
      return { where: () => Promise.resolve(undefined) };
    },
  };
}
const fakeTx = makeTx();

// Table sentinels so assertions can identify which table each op targeted.
vi.mock("@oxagen/database", () => ({
  withSystemDb: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
  schema: {
    privacyErasureRequests: { id: "erasure.id" },
    users: { id: "users.id" },
    accounts: { userId: "accounts.userId" },
    userPreferences: { userId: "userPreferences.userId" },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ col, val }),
  };
});

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

// Capture both handlers (main + on-failure) keyed by their function id.
type Handler = (ctx: {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sleep: (name: string, until: string) => Promise<void>;
  };
}) => Promise<unknown>;

const handlers: Record<string, Handler> = {};
mocks.inngestCreateFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: Handler) => {
    handlers[opts.id] = handler;
    return {};
  },
);

await import("./privacy.erasure.execute");

function getHandler(id: string): Handler {
  const handler = handlers[id];
  if (!handler) throw new Error(`handler not registered: ${id}`);
  return handler;
}

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
    sleep: vi.fn(async () => undefined),
  };
}

type UpdateCall = { table: { id?: string }; payload: Record<string, unknown> };
type DeleteCall = { table: { userId?: string } };

// ─────────────────────────────────────────────────────────────────────────────

describe("privacyErasureExecute Inngest handler", () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.deleteFrom.mockClear();
    mocks.loggerInfo.mockClear();
    mocks.loggerWarn.mockClear();
    mocks.loggerError.mockClear();
  });

  const baseEvent = {
    requestId: "req-1",
    userId: "user-1",
    orgId: "org-1",
    scope: "user" as const,
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };

  it("purges owned auth PII (users/accounts/preferences) then fails loud, never marking completed", async () => {
    const handler = getHandler("privacy.erasure-execute");
    expect(handler).toBeDefined();

    await expect(
      handler({ event: { data: baseEvent }, step: makeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    const updates = mocks.updateSet.mock.calls.map((c) => c[0] as UpdateCall);
    const deletes = mocks.deleteFrom.mock.calls.map((c) => c[0] as DeleteCall);

    // processing transition happened
    expect(updates.some((c) => c.payload.status === "processing")).toBe(true);

    // user identity row anonymised: email + display name replaced, avatar nulled.
    const userUpdate = updates.find((c) => c.table.id === "users.id");
    expect(userUpdate).toBeDefined();
    expect(userUpdate?.payload.email).toBe("user-1@deleted.invalid");
    expect(userUpdate?.payload.displayName).toBe("Deleted User");
    expect(userUpdate?.payload.avatarUrl).toBeNull();

    // OAuth tokens + password hash purged, personal preferences removed.
    expect(deletes.some((c) => c.table.userId === "accounts.userId")).toBe(
      true,
    );
    expect(
      deletes.some((c) => c.table.userId === "userPreferences.userId"),
    ).toBe(true);

    // CRITICAL: never marked completed.
    expect(updates.some((c) => c.payload.status === "completed")).toBe(false);
  });

  it("mid-cascade: the request is never transitioned to completed even though PII was touched", async () => {
    const handler = getHandler("privacy.erasure-execute");

    await expect(
      handler({ event: { data: baseEvent }, step: makeStep() }),
    ).rejects.toBeInstanceOf(NonRetriableError);

    // The only status transition the main handler performs is "processing".
    // Marking "failed" is the on-failure handler's job; "completed" must never
    // appear on the main path while stores remain un-erased.
    const statuses = mocks.updateSet.mock.calls
      .map((c) => (c[0] as UpdateCall).payload.status)
      .filter(Boolean);
    expect(statuses).toEqual(["processing"]);
  });

  it("fail-loud message enumerates every residual store blocking completion", async () => {
    const handler = getHandler("privacy.erasure-execute");
    try {
      await handler({ event: { data: baseEvent }, step: makeStep() });
      throw new Error("expected the handler to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("OXA-1721");
      expect(message).toContain("ClickHouse");
      expect(message).toContain("Neo4j");
      expect(message).toContain("blob");
      expect(message).toContain("org-scope");
    }
  });

  it("fails loud for org scope without touching users/accounts/preferences", async () => {
    const handler = getHandler("privacy.erasure-execute");
    await expect(
      handler({
        event: { data: { ...baseEvent, scope: "org" } },
        step: makeStep(),
      }),
    ).rejects.toThrow(/OXA-1721/);

    const updates = mocks.updateSet.mock.calls.map((c) => c[0] as UpdateCall);
    const deletes = mocks.deleteFrom.mock.calls.map((c) => c[0] as DeleteCall);
    // org scope only marks processing — it never anonymises the user or purges
    // owned rows, because org-scope semantics are undefined.
    expect(updates.some((c) => c.table.id === "users.id")).toBe(false);
    expect(deletes.length).toBe(0);
  });

  it("on-failure handler marks the request failed with the error message", async () => {
    const handler = getHandler("privacy.erasure-execute.on-failure");
    expect(handler).toBeDefined();

    await handler({
      event: {
        data: {
          event: { data: { requestId: "req-1" } },
          error: { message: "boom" },
        },
      },
      step: makeStep(),
    });

    const updates = mocks.updateSet.mock.calls.map((c) => c[0] as UpdateCall);
    expect(
      updates.some(
        (c) =>
          c.payload.status === "failed" && c.payload.errorMessage === "boom",
      ),
    ).toBe(true);
  });

  it("on-failure handler is a no-op when requestId is missing", async () => {
    const handler = getHandler("privacy.erasure-execute.on-failure");
    await handler({
      event: { data: { event: { data: {} }, error: "x" } },
      step: makeStep(),
    });
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.deleteFrom).not.toHaveBeenCalled();
  });
});
